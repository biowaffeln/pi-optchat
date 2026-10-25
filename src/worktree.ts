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
/** No hooks (a post-checkout or post-commit one could fail or hang with no one to answer it). */
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null'];

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
  await git(repo, ...NO_HOOKS, 'worktree', 'add', '-b', branch, path, head);
  return { tree: { repo, path, branch, base: head }, cwd: prefix ? join(path, prefix) : path };
}

/** Brings back a worktree that was removed when its run settled, for a resumed run: from its branch, or its base if the branch is gone. */
export async function reopenWorktree(tree: Worktree) {
  if (existsSync(tree.path)) return;
  if (!existsSync(tree.repo)) throw new Error(`its repository ${tree.repo} no longer exists`);
  await quietly(tree.repo, 'worktree', 'prune');
  mkdirSync(join(dataHome(), 'worktrees'), { recursive: true, mode: 0o700 });
  if (await quietly(tree.repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${tree.branch}`)) await git(tree.repo, ...NO_HOOKS, 'worktree', 'add', tree.path, tree.branch);
  else await git(tree.repo, ...NO_HOOKS, 'worktree', 'add', '-b', tree.branch, tree.path, tree.base);
}

/** A settle that stopped partway. Its message is the line for the report: what was done, what was left where, and why. */
export class SettleError extends Error {}
const reason = (error: unknown) => error instanceof Error ? error.message : String(error);
/** git, tried once more after a short pause when a lock was in the way: runs settling at the same time in one repository can collide on its ref locks. */
async function retried(cwd: string, ...args: string[]) {
  try { return await git(cwd, ...args); }
  catch (error) {
    if (!/\.lock\b|cannot lock/i.test(reason(error))) throw error;
    await new Promise(resolve => setTimeout(resolve, 300 + Math.random() * 300));
    return git(cwd, ...args);
  }
}

/**
 * Why the worktree's changes can't safely be committed on its branch, or undefined when they can: its HEAD must be the branch
 * itself, with no rebase, merge, cherry-pick or revert under way. Otherwise a commit would land somewhere else, and removing the
 * worktree and deleting the branch would lose the child's work.
 */
async function offBranch(tree: Worktree) {
  const ref = await git(tree.path, 'symbolic-ref', '-q', 'HEAD').catch(() => undefined);
  if (!ref) return `its HEAD is detached (at ${await git(tree.path, 'rev-parse', '--short', 'HEAD').catch(() => 'no commit')}) instead of on ${tree.branch}`;
  if (ref !== `refs/heads/${tree.branch}`) return `it has ${ref.replace(/^refs\/heads\//, '')} checked out instead of ${tree.branch}`;
  const states = { 'rebase-merge': 'a rebase', 'rebase-apply': 'a rebase', MERGE_HEAD: 'a merge', CHERRY_PICK_HEAD: 'a cherry-pick', REVERT_HEAD: 'a revert' };
  const paths = (await git(tree.path, 'rev-parse', '--path-format=absolute', ...Object.keys(states).flatMap(name => ['--git-path', name]))).split('\n');
  const busy = Object.values(states).find((_, i) => existsSync(paths[i]));
  return busy && `${busy} is in progress in it`;
}

/**
 * Settles a run's worktree: commits what is left uncommitted on its branch, then removes the worktree. The branch stays when it
 * holds any commit past its base (the child's own commits count too) and is deleted otherwise. Returns a line for the report;
 * a `SettleError` says which step failed and what is left. When the worktree is not on its branch it is left untouched.
 */
export async function finishWorktree(tree: Worktree, message: string) {
  const where = `Its worktree ${tree.path} (branch ${tree.branch})`;
  if (existsSync(tree.path)) {
    const why = await offBranch(tree);
    if (why) throw new SettleError(`${where} was left as it is, with nothing committed, because ${why}.`);
    try {
      await git(tree.path, 'add', '-A');
      if (!await quietly(tree.path, 'diff', '--cached', '--quiet')) {
        // Works without a configured identity too. Hooks and signing are skipped: a failing hook, or a signer that wants a
        // passphrase with no terminal to ask on, would strand the worktree on every settle.
        const identity = await quietly(tree.path, 'config', 'user.email') ? [] : ['-c', 'user.name=OptChat', '-c', 'user.email=optchat@localhost'];
        await retried(tree.path, ...identity, ...NO_HOOKS, '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-q', '-m', message);
      }
    } catch (error) { throw new SettleError(`${where} could not be committed, so it was left as it is: ${reason(error)}`); }
  }
  let branch: boolean, commits: number;
  try {
    branch = await quietly(tree.repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${tree.branch}`);
    commits = branch ? Number(await git(tree.repo, 'rev-list', '--count', `${tree.base}..${tree.branch}`)) : 0;
  } catch (error) { throw new SettleError(`${where} was left in place, since its branch could not be read: ${reason(error)}`); }
  const kept = commits > 0 ? `Its changes are on branch ${tree.branch} in ${tree.repo} (${commits} commit${commits === 1 ? '' : 's'} past ${tree.base.slice(0, 7)})` : '';
  try {
    if (existsSync(tree.path)) await retried(tree.repo, 'worktree', 'remove', '--force', tree.path);
    else await quietly(tree.repo, 'worktree', 'prune');
  } catch (error) { throw new SettleError(`${kept ? `${kept}, but its` : 'Its'} worktree ${tree.path} could not be removed: ${reason(error)}`); }
  if (kept) return `${kept}; its worktree was removed.`;
  if (branch) {
    try { await retried(tree.repo, 'branch', '-D', tree.branch); }
    catch (error) { throw new SettleError(`It changed no files, so its worktree was removed, but its empty branch ${tree.branch} could not be deleted: ${reason(error)}`); }
  }
  return `It changed no files, so its worktree and branch ${tree.branch} were removed.`;
}

/** Drops a worktree and its branch that never ran, after a failed launch. */
export async function discardWorktree(tree: Worktree) {
  await quietly(tree.repo, 'worktree', 'remove', '--force', tree.path);
  await quietly(tree.repo, 'branch', '-D', tree.branch);
}
