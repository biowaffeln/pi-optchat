import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorktree, finishWorktree, reopenWorktree, repoOf } from '../src/worktree.ts';
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
