import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { branchDirectory, listBranches } from '../src/branch.ts';
import type { Entry } from '../src/memory.ts';

// Every Pi session on a profile runs as a branch in `<profile>/branches/<id>/`, so tests that look at a session's files find
// them here: its own log while it is open, its journals, and what the trunk plus its own log add up to.

/** The folder of the profile's newest branch, open or closed. */
export function lastBranchDir(profile: string) {
  const info = listBranches(profile).at(-1);
  if (!info) throw new Error(`No branch in ${profile}`);
  return branchDirectory(profile, info.id);
}
/** The folder of the profile's newest branch that hasn't closed: the session that is open now. */
export function openBranchDir(profile: string) {
  const info = listBranches(profile).filter(b => !b.closed).at(-1);
  if (!info) throw new Error(`No open branch in ${profile}`);
  return branchDirectory(profile, info.id);
}
/** The messages logged in a memory folder's `main/` (the trunk's or one branch's own), in order. */
export function logIn(dir: string): Entry[] {
  const main = join(dir, 'main');
  if (!existsSync(main)) return [];
  return readdirSync(main).filter(f => f.endsWith('.jsonl')).sort()
    .flatMap(file => readFileSync(join(main, file), 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as Entry))
    .sort((a, b) => a.i - b.i);
}
/** What the open session's memory holds: the trunk's messages up to where its branch started, then the branch's own. With no
 * session open, the trunk's log. */
export function sessionLog(profile: string): Entry[] {
  const open = listBranches(profile).filter(b => !b.closed).at(-1);
  if (!open) return logIn(profile);
  return [...logIn(profile).filter(e => e.i < open.base), ...logIn(branchDirectory(profile, open.id))];
}
