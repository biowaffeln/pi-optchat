import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorktree, finishWorktree, reopenWorktree, repoOf, SettleError } from '../src/worktree.ts';
import { removeDir } from './support.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
function repo(dir: string) {
  const path = join(dir, 'repo');
  mkdirSync(join(path, 'sub'), { recursive: true });
  git(path, 'init', '-q', '-b', 'main');
  git(path, 'config', 'user.email', 'test@example.com'); git(path, 'config', 'user.name', 'Test');
  writeFileSync(join(path, 'README.md'), 'hello\n'); writeFileSync(join(path, 'sub', 'keep.txt'), 'x\n');
  git(path, 'add', '-A'); git(path, 'commit', '-q', '-m', 'init');
  return realpathSync(path);
}
const branches = (path: string) => git(path, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean).sort();
let ids = 0;
const id = () => `wt${process.pid}${ids++}`;

test('a worktree made from inside a linked worktree belongs to the main repository and outlives the one it came from', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-wt-nested-')), path = repo(dir);
  try {
    // The user's own linked worktree, on a branch with a commit main does not have.
    const own = join(dir, 'own');
    git(path, 'worktree', 'add', '-q', '-b', 'feature', own);
    writeFileSync(join(own, 'feature.txt'), 'f\n'); git(own, 'add', '-A'); git(own, 'commit', '-q', '-m', 'feature');
    const fromOwn = await repoOf(join(own, 'sub'));
    assert.equal(realpathSync(fromOwn.repo), path);
    assert.equal(fromOwn.head, git(own, 'rev-parse', 'HEAD'), 'the base is the HEAD of the checkout the task is in');
    assert.equal(fromOwn.prefix, 'sub');

    const parent = await createWorktree(own, id()), child = await createWorktree(join(parent.cwd, 'sub'), id());
    assert.equal(realpathSync(child.tree.repo), path, 'the grandchild records the main repository, not its parent\'s worktree');
    assert.equal(child.cwd, join(child.tree.path, 'sub'));
    assert.ok(existsSync(join(child.cwd, 'keep.txt')) && existsSync(join(child.tree.path, 'feature.txt')));

    assert.match(await finishWorktree(parent.tree, 'parent'), /changed no files/);
    assert.ok(!existsSync(parent.tree.path));
    writeFileSync(join(child.cwd, 'made.txt'), 'made\n');
    assert.match(await finishWorktree(child.tree, 'child'), /1 commit past/);
    assert.equal(git(path, 'show', `${child.tree.branch}:sub/made.txt`), 'made');
    await reopenWorktree(child.tree);
    assert.ok(existsSync(join(child.tree.path, 'sub', 'made.txt')), 'and it can be reopened after its parent is gone');
    await finishWorktree(child.tree, 'again');
    assert.deepEqual(branches(path), ['feature', child.tree.branch, 'main'].sort());
  } finally { removeDir(dir); }
});

test('a worktree whose HEAD left its branch, or with a merge under way, is left as it is with the child\'s work in it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-wt-offbranch-')), path = repo(dir);
  try {
    const detached = (await createWorktree(path, id())).tree;
    writeFileSync(join(detached.path, 'a.txt'), 'a\n'); git(detached.path, 'add', '-A'); git(detached.path, 'commit', '-q', '-m', 'a');
    git(detached.path, 'checkout', '-q', '--detach');
    writeFileSync(join(detached.path, 'b.txt'), 'b\n'); git(detached.path, 'add', '-A'); git(detached.path, 'commit', '-q', '-m', 'b');
    const head = git(detached.path, 'rev-parse', 'HEAD');
    await assert.rejects(finishWorktree(detached, 'x'), (error: Error) => error instanceof SettleError
      && error.message.includes(`Its worktree ${detached.path} (branch ${detached.branch}) was left as it is, with nothing committed, because its HEAD is detached`));
    assert.equal(git(detached.path, 'rev-parse', 'HEAD'), head, 'the detached commit is still checked out');

    const other = (await createWorktree(path, id())).tree;
    git(other.path, 'checkout', '-q', '-b', 'elsewhere');
    writeFileSync(join(other.path, 'c.txt'), 'c\n');
    await assert.rejects(finishWorktree(other, 'x'), /it has elsewhere checked out instead of optchat\//);
    assert.ok(existsSync(join(other.path, 'c.txt')));

    const merging = (await createWorktree(path, id())).tree;
    git(merging.path, 'checkout', '-q', '-b', 'side'); writeFileSync(join(merging.path, 'README.md'), 'side\n'); git(merging.path, 'commit', '-qam', 'side');
    git(merging.path, 'checkout', '-q', merging.branch); writeFileSync(join(merging.path, 'README.md'), 'mine\n'); git(merging.path, 'commit', '-qam', 'mine');
    assert.throws(() => git(merging.path, 'merge', '-q', 'side'));
    await assert.rejects(finishWorktree(merging, 'x'), /a merge is in progress in it/);
    assert.ok(existsSync(merging.path));

    for (const tree of [detached, other, merging]) assert.ok(branches(path).includes(tree.branch), 'no branch was deleted');
  } finally { removeDir(dir); }
});

test('when only the empty branch can\'t be deleted, the report says the worktree is gone and the branch is not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-wt-branch-')), path = repo(dir);
  try {
    const { tree } = await createWorktree(path, id());
    // Another worktree has the branch checked out, so git refuses to delete it.
    git(path, 'worktree', 'add', '-q', '-f', join(dir, 'theirs'), tree.branch);
    await assert.rejects(finishWorktree(tree, 'x'), (error: Error) => error instanceof SettleError
      && error.message.startsWith(`It changed no files, so its worktree was removed, but its empty branch ${tree.branch} could not be deleted: `));
    assert.ok(!existsSync(tree.path));
    assert.ok(branches(path).includes(tree.branch));
  } finally { removeDir(dir); }
});
