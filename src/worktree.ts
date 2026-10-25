import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { dataHome } from './profiles.ts';

const run = promisify(execFile);
/** A subagent's own git worktree: `path` on `branch`, made from `base` (a commit of `repo`). `cwd` is where the child works inside it. */
export interface Worktree { repo: string; path: string; branch: string; base: string }

async function git(cwd: string, ...args: string[]) {
  try { return (await run('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })).stdout.trim(); }
  catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(`git ${args.join(' ')} failed${stderr ? `: ${stderr}` : `: ${String(error)}`}`);
  }
}
const quietly = async (cwd: string, ...args: string[]) => { try { await git(cwd, ...args); return true; } catch { return false; } };

/**
 * The repository that holds `dir`, the HEAD commit of the checkout `dir` is in, and where `dir` sits inside that checkout
 * (`prefix`, empty at its top). `repo` is the main repository even when `dir` is in a linked worktree, so it outlives that
 * worktree: the main working tree for a normal repository, the git directory itself for a bare one (or one kept elsewhere).
 * Throws a plain message when there is no repository or no commit.
 */
export async function repoOf(dir: string) {
  let top: string, common: string, prefix: string;
  try {
    top = await git(dir, 'rev-parse', '--show-toplevel');
    common = await git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    prefix = (await git(dir, 'rev-parse', '--show-prefix')).replace(/\/$/, '');
  } catch { throw new Error(`isolation "worktree" needs a git repository, and ${dir} is not inside one.`); }
  const repo = basename(common) === '.git' && existsSync(dirname(common)) ? dirname(common) : common;
  let head: string;
  try { head = await git(dir, 'rev-parse', '--verify', 'HEAD^{commit}'); }
  catch { throw new Error(`isolation "worktree" needs a commit to start from, and ${top} has none yet.`); }
  return { repo, head, prefix };
}

/** Where worktrees live: outside every repository, beside the profiles. */
export const worktreePath = (id: string) => join(dataHome(), 'worktrees', id);
/**
 * A new worktree on branch `optchat/<id>` from the HEAD of the checkout holding `dir`, and `cwd`, the directory in it that
 * matches `dir`, so a task started in a subdirectory starts there again.
 */
export async function createWorktree(dir: string, id: string): Promise<{ tree: Worktree; cwd: string }> {
  const { repo, head, prefix } = await repoOf(dir), path = worktreePath(id), branch = `optchat/${id}`;
  mkdirSync(join(dataHome(), 'worktrees'), { recursive: true, mode: 0o700 });
  await git(repo, 'worktree', 'add', '-b', branch, path, head);
  return { tree: { repo, path, branch, base: head }, cwd: prefix ? join(path, prefix) : path };
}

/** Brings back a worktree that was removed when its run settled, for a resumed run: from its branch, or its base if the branch is gone. */
export async function reopenWorktree(tree: Worktree) {
  if (existsSync(tree.path)) return;
  if (!existsSync(tree.repo)) throw new Error(`its repository ${tree.repo} no longer exists`);
  await quietly(tree.repo, 'worktree', 'prune');
  mkdirSync(join(dataHome(), 'worktrees'), { recursive: true, mode: 0o700 });
  if (await quietly(tree.repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${tree.branch}`)) await git(tree.repo, 'worktree', 'add', tree.path, tree.branch);
  else await git(tree.repo, 'worktree', 'add', '-b', tree.branch, tree.path, tree.base);
}

/**
 * Settles a run's worktree: commits what is left uncommitted on its branch, then removes the worktree. The branch stays when it
 * holds any commit past its base (the child's own commits count too) and is deleted otherwise. Returns a line for the report.
 */
export async function finishWorktree(tree: Worktree, message: string) {
  if (existsSync(tree.path)) {
    await git(tree.path, 'add', '-A');
    if (!await quietly(tree.path, 'diff', '--cached', '--quiet')) {
      // Works without a configured identity too; hooks are skipped, since a failing one would strand the worktree.
      const identity = await quietly(tree.path, 'config', 'user.email') ? [] : ['-c', 'user.name=OptChat', '-c', 'user.email=optchat@localhost'];
      await git(tree.path, ...identity, 'commit', '--no-verify', '-q', '-m', message);
    }
  }
  const branch = await quietly(tree.repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${tree.branch}`);
  const commits = branch ? Number(await git(tree.repo, 'rev-list', '--count', `${tree.base}..${tree.branch}`)) : 0;
  if (existsSync(tree.path)) await git(tree.repo, 'worktree', 'remove', '--force', tree.path);
  else await quietly(tree.repo, 'worktree', 'prune');
  if (commits > 0) return `Its changes are on branch ${tree.branch} in ${tree.repo} (${commits} commit${commits === 1 ? '' : 's'} past ${tree.base.slice(0, 7)}); its worktree was removed.`;
  if (branch) await git(tree.repo, 'branch', '-D', tree.branch);
  return `It changed no files, so its worktree and branch ${tree.branch} were removed.`;
}

/** Drops a worktree and its branch that never ran, after a failed launch. */
export async function discardWorktree(tree: Worktree) {
  await quietly(tree.repo, 'worktree', 'remove', '--force', tree.path);
  await quietly(tree.repo, 'branch', '-D', tree.branch);
}
