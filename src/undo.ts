import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { record } from './cache.ts';
import { bytes, end, isEntry, type Entry, type Memory, type Part } from './memory.ts';
import { atomicWrite, FileStore } from './store.ts';

// /undo takes back the user's last message in this session, with everything logged after it (the reply, tool calls and their
// results), so the next turn's context no longer has it. It only works on the session's own log, and only on what the trunk
// doesn't have yet: a message that was merged into the profile's shared memory, or folded into a summary line of the view,
// stays. Notes from other sessions and subagent reports logged after the message are kept, since nothing would deliver them
// again; they go back in after the cut.
//
// The cut is a few file rewrites, so it is written down first as an intent (`undo.json`: where to cut, and the lines to put
// back). Finishing it cuts again and appends those lines again, so it can be repeated: a branch whose Pi died halfway is
// finished the next time its log loads, whether by this session or by the one that recovers it.

/** Tools that only read memory or the profile, so taking back their calls leaves nothing behind. */
const HARMLESS = new Set(['zoom', 'date', 'search', 'peers', 'ask_peer', 'models']);
const GUIDANCE = 'Direct guidance to subagent [';

/** Lines logged after the message that /undo keeps: they came from elsewhere, not from the exchange it takes back. */
const kept = (entry: Entry) => entry.kind === 'note' || entry.kind === 'work' || entry.kind === 'user' && entry.text.startsWith(GUIDANCE);
/** The user's own words: what the chat logs as `user`, not guidance the user gave a subagent through the agent view. */
const typed = (entry: Entry) => entry.kind === 'user' && !entry.text.startsWith(GUIDANCE);

export interface UndoPlan {
  /** The index of the message taken back; the log is cut there. */
  at: number;
  /** The message as logged, and when. */
  text: string; date: string;
  /** Lines after it that go back in after the cut. */
  keep: Entry[];
  /** Lines taken back, the message included. */
  removed: number;
  /** Tools the taken-back turn ran that may have changed something outside the log. */
  tools: string[];
}

/** What /undo would take back from `memory`, whose messages from `from` on are this session's own and not yet merged.
 * A string says why there is nothing it may take back. */
export function planUndo(memory: Memory, from: number): UndoPlan | string {
  const root = memory.root;
  const at = root.findLastIndex(typed);
  if (at < 0) return 'Nothing to undo: this chat has no message of yours yet.';
  if (at < from) return 'Nothing to undo: your last message is already in the profile\'s shared memory (merged when idle, or as this session caught up with the others), so it stays.';
  const line = memory.covering(at);
  if (line && line.l > 0) return 'Your last message is already folded into a summary line of the memory view, so it can\'t be taken back on its own.';
  const tail = root.slice(at + 1);
  const tools = [...new Set(tail.filter(e => e.kind === 'tool').map(e => e.text.split(' ', 1)[0]).filter(name => !HARMLESS.has(name)))];
  const keep = tail.filter(kept);
  return { at, text: root[at].text, date: root[at].date, keep, removed: root.length - at - keep.length, tools };
}

/** Rewrites each JSONL file in `folder` without the records `drop` picks. A line that doesn't parse stays as it is. */
function rewrite(folder: string, drop: (value: unknown) => boolean) {
  if (!existsSync(folder)) return;
  // Newest day first: the lines a cut drops are usually all in today's file. A cut stopped halfway is finished from undo.json.
  for (const name of readdirSync(folder).filter(n => n.endsWith('.jsonl')).sort().reverse()) {
    const file = join(folder, name), lines = readFileSync(file, 'utf8').split('\n').filter(line => line.trim());
    const left = lines.filter(line => { try { return !drop(JSON.parse(line)); } catch { return true; } });
    if (left.length !== lines.length) atomicWrite(file, left.map(line => line + '\n').join(''));
  }
}
/** A saved view's lines that end by `at`: they tile the log from the start, so these are its prefix. */
function prefix(saved: unknown, at: number): unknown {
  const cut = (parts: unknown[]) => {
    const kept: unknown[] = [];
    for (const value of parts) {
      const [l, i] = Array.isArray(value) ? value : [];
      if (!Number.isSafeInteger(l) || !Number.isSafeInteger(i) || end({ l, i } as Part) > at) break;
      kept.push(value);
    }
    return kept;
  };
  if (Array.isArray(saved)) return cut(saved);
  if (record(saved) && Array.isArray(saved.parts)) return { ...saved, parts: cut(saved.parts), ...record(saved.compaction) ? { compaction: prefix(saved.compaction, at) } : {} };
  return saved;
}

/** Cuts a branch's own log at message `at`: its messages from `at` on, the summary nodes that reach them, and the view's lines
 * past them are dropped. Call it with the branch's memory closed, then open it again. The tree and view go first: a log
 * shorter than its nodes would refuse to open after a crash, while missing nodes are just built again. */
export function cutBranch(dir: string, at: number) {
  rewrite(join(dir, 'tree'), value => record(value) && Number.isSafeInteger(value.l) && Number.isSafeInteger(value.i) && end({ l: Number(value.l), i: Number(value.i) }) > at);
  const file = join(dir, 'view.json');
  if (existsSync(file)) {
    let saved: unknown;
    try { saved = JSON.parse(readFileSync(file, 'utf8')); } catch { saved = undefined; }
    // An unreadable view is rebuilt on open either way.
    if (saved !== undefined) atomicWrite(file, JSON.stringify(prefix(saved, at)));
  }
  rewrite(join(dir, 'main'), value => isEntry(value) && value.i >= at);
}

const INTENT = 'undo.json';
interface Intent { at: number; keep: Entry[] }

/** Writes down a cut before any of it happens, so a crash can't lose the lines it puts back. */
export function writeUndo(dir: string, plan: Pick<UndoPlan, 'at' | 'keep'>) {
  atomicWrite(join(dir, INTENT), JSON.stringify({ at: plan.at, keep: plan.keep } satisfies Intent));
}
/** Finishes a cut written down in the branch folder, if there is one: cuts the log there, appends the kept lines after it,
 * and removes the intent. Safe to run again after a crash at any point. Returns whether there was one. Call it with no memory
 * open on the folder. */
export function finishUndo(dir: string, warn: (text: string) => void = console.error) {
  const file = join(dir, INTENT);
  if (!existsSync(file)) return false;
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!record(value) || !Number.isSafeInteger(value.at) || !Array.isArray(value.keep) || !value.keep.every(isEntry))
    throw new Error(`${file} is damaged; refusing to open this session's memory until it is fixed or removed.`);
  const at = Number(value.at);
  cutBranch(dir, at);
  const store = new FileStore(dir, warn);
  store.load();
  value.keep.forEach((entry, k) => {
    const { kind, text, date, receipt, origin } = entry;
    store.append({ i: at + k, kind, text, date, size: bytes(`${kind}: ${text}`), ...receipt ? { receipt } : {}, ...origin ? { origin } : {} });
  });
  rmSync(file);
  return true;
}
