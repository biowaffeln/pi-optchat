import { randomBytes } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import { record } from './cache.ts';
import { memoryDirectory } from './import/job.ts';
import { holder, lockPath, takeLock, withLock } from './locks.ts';
import { bytes, end, flat, isEntry, Memory, start, type Entry, type Compressor, type Kind, type Summary } from './memory.ts';
import { sessionMessages } from './runs.ts';
import { noteReceipt, notesText, peekNotes } from './peers.ts';
import { reportReceipt } from './transcript.ts';
import { atomicWrite, FileStore, type Mime, type Saved, type Store } from './store.ts';

// A profile's memory is a trunk with branches. The trunk is the profile's memory directory (as before: `main/`, `tree/`,
// `view.json`), and nobody chats in it. Every Pi session on the profile is a branch: it starts from the trunk's end, sees the
// trunk's messages as its own first ones, and logs its own after them in `branches/<id>/`, with one writer, so inside a
// branch the chat, its tree and its cache work exactly as in the recipe. A branch merges into the trunk when it closes, when
// it has been idle a while, and when its view batch-merges (then it also starts again from the trunk's new end: a rebase).
//
// Merging appends the branch's new messages to the trunk's end in one block, keeping their dates. A summary node covers a
// fixed range of indices, so the branch's nodes stay valid where its messages keep their indices, or move by a multiple of the
// node's size; the rest are rebuilt by whoever next needs them. When no other branch merged in between, nothing moves at all.
//
// The trunk's files change only under the trunk lock, held for one read and append, never across a model call.

export interface BranchInfo {
  id: string;
  /** The trunk's length when this branch started: messages before it are the trunk's, from it on the branch's own. */
  base: number;
  created: string; cwd: string; pid: number; host: string;
  /** The trunk's memory folder, relative to the profile ('.' unless an import made a new generation): a branch merges only there. */
  trunk?: string;
  /** Set when the branch closed and merged everything; a branch without it whose process is gone crashed. */
  closed?: string;
  /** Set when the branch asked to close, so a merge that failed after it is finished as a close, not as a crash. */
  closing?: boolean;
}
export type MergeReason = 'close' | 'idle' | 'rebase' | 'interrupted';
export interface MergeResult { added: number; at: number; length: number; moved: boolean; copied: number }

const BRANCHES = 'branches';
const INFO = 'branch.json';
export const branchesDirectory = (profile: string) => join(profile, BRANCHES);
export const branchDirectory = (profile: string, id: string) => join(profile, BRANCHES, id);
/** The trunk's own lock, held for a moment around each read of or write to its files. */
export const trunkLock = (profile: string) => lockPath(profile, 'trunk');
/** Held by a branch's process for as long as it runs: a branch whose lock answers is live. */
export const liveLock = (dir: string) => lockPath(dir, 'live');
const LEGACY_LOCK = 'lock';

export function readInfo(dir: string): BranchInfo | undefined {
  let value: unknown;
  try { value = JSON.parse(readFileSync(join(dir, INFO), 'utf8')); } catch { return undefined; }
  if (!record(value) || typeof value.id !== 'string' || !Number.isSafeInteger(value.base) || typeof value.created !== 'string'
    || typeof value.cwd !== 'string' || typeof value.pid !== 'number' || typeof value.host !== 'string') return undefined;
  // SAFETY: every required field was checked above; the optional ones are only read as flags.
  return value as unknown as BranchInfo;
}
export const saveInfo = (dir: string, info: BranchInfo) => atomicWrite(join(dir, INFO), JSON.stringify(info, null, 2) + '\n');

/** Every branch folder with a readable branch.json, oldest first. */
export function listBranches(profile: string) {
  const root = branchesDirectory(profile);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter(f => f.isDirectory())
    .flatMap(f => { const info = readInfo(join(root, f.name)); return info?.id === f.name ? [info] : []; })
    .sort((a, b) => a.created.localeCompare(b.created));
}
/** What a live branch's lock answers with, or undefined if it isn't live. */
export async function liveStatus(profile: string, id: string) {
  const answer = await holder(liveLock(branchDirectory(profile, id)));
  if (answer === undefined) return undefined;
  try { const value: unknown = JSON.parse(answer); if (record(value)) return value; } catch { /* an older or busy holder */ }
  return { id };
}

/** The trunk's memory folder relative to the profile. */
const generation = (profile: string) => relative(profile, memoryDirectory(profile)).split(sep).join('/') || '.';
const describe = (what: string) => () => JSON.stringify({ what, pid: process.pid, host: hostname() });

/** The trunk's messages and nodes, read under its lock (a read mid-append would see a torn last line). */
function readTrunk(profile: string, warn: (text: string) => void) {
  const directory = memoryDirectory(profile), store = new FileStore(directory, warn), saved = store.load();
  const entries = saved.entries.filter(isEntry).sort((a, b) => a.i - b.i);
  if (entries.length !== saved.entries.length || entries.some((e, i) => e.i !== i)) throw new Error('Invalid/noncontiguous OptChat log; refusing to change it.');
  return { directory, store, saved, entries };
}

/** A profile last opened by OptChat before branches had one Pi holding `lock.sock`; it must not run beside this one. */
async function refuseLegacyOwner(profile: string) {
  const owner = await holder(lockPath(profile, LEGACY_LOCK));
  if (owner !== undefined) throw new Error(`This profile is open in an older OptChat (${owner}). Close that Pi first: it expects to be the profile's only writer.`);
}

/** Starts a branch at the trunk's current end. Its process holds the returned lock release until it closes. */
export async function startBranch(profile: string, cwd: string, warn: (text: string) => void) {
  await refuseLegacyOwner(profile);
  mkdirSync(branchesDirectory(profile), { recursive: true, mode: 0o700 });
  // Branch folders hold runs and their transcripts; the profile's Git checkpoints skip those, as they skip the profile's own runs.
  const ignore = join(branchesDirectory(profile), '.gitignore');
  // So do what a branch publishes for its peers, which changes every turn.
  const ignored = '*/runs/\n*.sock\n*.tmp\n*/view.txt\n*/turn.txt\n*/notes.read\n';
  if (!existsSync(ignore) || readFileSync(ignore, 'utf8') !== ignored) atomicWrite(ignore, ignored);
  let id: string, dir: string;
  do { id = randomBytes(4).toString('hex').slice(0, 6); dir = branchDirectory(profile, id); } while (existsSync(dir));
  mkdirSync(dir, { mode: 0o700 });
  const info: BranchInfo = { id, base: 0, created: new Date().toISOString(), cwd, pid: process.pid, host: hostname() };
  let status: Record<string, unknown> = { id, cwd, pid: info.pid, host: info.host, created: info.created };
  const release = await takeLock(liveLock(dir), () => JSON.stringify(status));
  try {
    await withLock(trunkLock(profile), describe(`starting branch ${id}`), () => {
      const trunk = readTrunk(profile, warn);
      info.base = trunk.entries.length; info.trunk = generation(profile);
      // The trunk's saved view becomes the branch's: a branch that only grows from it reads the same prefix from the cache.
      if (trunk.saved.view !== undefined) atomicWrite(join(dir, 'view.json'), trunk.saved.view);
      saveInfo(dir, info);
      // Journals from before branches (one per profile) go to the first branch that opens, which delivers them.
      for (const name of ['pending-inputs.json', 'pending-reports.json']) {
        if (existsSync(join(profile, name))) renameSync(join(profile, name), join(dir, name));
      }
      adoptRuns(profile, dir);
    });
  } catch (error) { await release(); rmSync(dir, { recursive: true, force: true }); throw error; }
  return { info, dir, release, setStatus: (next: Record<string, unknown>) => { status = { ...next, id }; } };
}

/** Subagents belong to the session that started them, but a session that closed (or crashed and was recovered) leaves its
 * runs to the next one that starts: the cut-off ones are resumed there, and `tell` can resume the finished ones, as when one
 * Pi held the profile. The profile's own `runs/` from before branches goes the same way. Runs under the trunk lock, so two
 * sessions starting at once don't split them. */
function adoptRuns(profile: string, dir: string) {
  const to = join(dir, 'runs');
  const from = [profile, ...listBranches(profile).filter(info => info.closed).map(info => branchDirectory(profile, info.id))].map(folder => join(folder, 'runs'));
  for (const folder of from) {
    if (!existsSync(folder)) continue;
    mkdirSync(to, { recursive: true, mode: 0o700 });
    // Transcripts first: metadata without its transcript would look like a run whose chat is lost.
    const files = readdirSync(folder).sort((a, b) => Number(a.endsWith('.optchat.json')) - Number(b.endsWith('.optchat.json')));
    for (const file of files) if (!existsSync(join(to, file))) renameSync(join(folder, file), join(to, file));
  }
}

/** A branch's memory: the trunk's first `base` messages and their nodes, then the branch's own, which it alone writes. */
export class BranchStore implements Store {
  private readonly own: FileStore;
  constructor(readonly profile: string, readonly directory: string, readonly base: number, private readonly report: (text: string) => void = console.error) {
    this.own = new FileStore(directory, report);
  }
  async load(): Promise<Saved> {
    const own = this.own.load();
    const trunk = await withLock(trunkLock(this.profile), describe('reading the trunk'), () => readTrunk(this.profile, this.report));
    if (trunk.entries.length < this.base) throw new Error(`The trunk has ${trunk.entries.length} messages, fewer than this branch started from (${this.base}); refusing to open it.`);
    const tree = trunk.saved.tree.filter(n => isNode(n) && end(n) <= this.base);
    return { entries: [...trunk.entries.slice(0, this.base), ...own.entries], tree: [...tree, ...own.tree], view: own.view ?? trunk.saved.view };
  }
  append(entry: Entry) { return this.own.append(entry); }
  appendNode(node: Summary) { return this.own.appendNode(node); }
  saveView(view: string) { return this.own.saveView(view); }
  putImage(name: string, mimeType: Mime, data: Uint8Array) { return this.own.putImage(name, mimeType, data); }
  image(name: string) { return this.own.image(name) ?? new FileStore(memoryDirectory(this.profile), this.report).image(name); }
}

const key = ({ l, i }: { l: number; i: number }) => `${l}/${i}`;
const when = (date: string) => { const d = new Date(date); return Number.isNaN(d.getTime()) ? date : d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }); };

/** Appends the branch's messages the trunk doesn't have yet, and every node of the branch that still fits there, under the
 * trunk lock. `entries` are the branch's whole log (or just its own part), `nodes` every node it has. What the trunk has from
 * this branch is read from the trunk itself, so a merge cut off halfway is finished by the next one, never repeated. */
export async function mergeBranch(profile: string, dir: string, info: BranchInfo, entries: readonly Entry[], nodes: Iterable<Summary>,
  reason: MergeReason, warn: (text: string) => void = console.error): Promise<MergeResult> {
  return withLock(trunkLock(profile), describe(`merging branch ${info.id}`), () => {
    if ((info.trunk ?? '.') !== generation(profile)) throw new Error(`Branch ${info.id} started from memory ${info.trunk ?? '.'}, but an import has since made ${generation(profile)} the profile's memory; its messages stay in ${dir}.`);
    const trunk = readTrunk(profile, warn);
    const mapped = new Map<number, number>();
    for (const e of trunk.entries) if (e.branch?.id === info.id) mapped.set(e.branch.i, e.i);
    let merged = info.base;
    for (const i of mapped.keys()) merged = Math.max(merged, i + 1);
    const pending = entries.filter(e => e.i >= merged).sort((a, b) => a.i - b.i);
    if (pending.some((e, k) => e.i !== merged + k)) throw new Error(`Branch ${info.id}'s log has a gap after message ${merged}; refusing to merge it.`);
    let at = trunk.entries.length;
    const first = at;
    const append = (kind: Kind, text: string, date: string, extra: Partial<Entry> = {}) => {
      const entry: Entry = { i: at++, kind, text, date, size: bytes(`${kind}: ${text}`), ...extra };
      trunk.store.append(entry);
      return entry;
    };
    // A block that doesn't go where the branch's messages left off sits after other sessions' messages, so it says where it came from.
    const moved = pending.length > 0 && at !== merged;
    if (moved) {
      const last = pending.at(-1)!;
      append('note', `Another session's messages follow: branch ${info.id}, in ${info.cwd}, started ${when(info.created)}. Its ${pending.length} messages from ${when(pending[0].date)} to ${when(last.date)} ran alongside the ones above and were merged ${reason === 'close' ? 'when it closed' : reason === 'idle' ? 'while it was idle' : reason === 'rebase' ? 'as it caught up with the others' : 'after it stopped unexpectedly'}.`, pending[0].date);
    }
    for (const e of pending) {
      const { i, kind, text, date, receipt, origin } = e;
      append(kind, text, date, { ...receipt ? { receipt } : {}, ...origin ? { origin } : {}, branch: { id: info.id, i } });
      mapped.set(i, at - 1);
    }
    if (reason === 'interrupted' && pending.length) append('note', `Branch ${info.id} (in ${info.cwd}) ended without closing: its Pi crashed or was killed, so its last turn may be unfinished.`, new Date().toISOString());
    // A node moves with its messages when all of them moved by the same shift, and that shift is a multiple of its size.
    const have = new Set(trunk.saved.tree.flatMap(n => record(n) && Number.isSafeInteger(n.l) && Number.isSafeInteger(n.i) ? [key({ l: Number(n.l), i: Number(n.i) })] : []));
    const shift = (j: number) => j < info.base ? 0 : mapped.get(j) === undefined ? undefined : mapped.get(j)! - j;
    let copied = 0;
    for (const node of nodes) {
      const from = start(node), to = end(node), d = shift(from), size = 2 ** node.l;
      if (d === undefined || d % size || (to > info.base && !range(from, to, j => shift(j) === d))) continue;
      const moved = { l: node.l, i: node.i + d / size };
      if (end(moved) > at || have.has(key(moved))) continue;
      trunk.store.appendNode({ ...moved, text: node.text, size: bytes(flat(node.text)) });
      have.add(key(moved)); copied++;
    }
    copyImages(dir, trunk.directory);
    // Save the trunk's view as the trunk would have it now, so the next branch starts from it. Nothing is summarized here:
    // a missing node is built by the first branch whose view needs it.
    new Memory(trunk.directory, () => Promise.reject(new Error('not summarizing')), warn, undefined, 0).close().catch(() => {});
    return { added: pending.length, at: first, length: at, moved, copied };
  });
}
function range(from: number, to: number, ok: (j: number) => boolean) {
  for (let j = from; j < to; j++) if (!ok(j)) return false;
  return true;
}
function copyImages(from: string, to: string) {
  const source = join(from, 'images');
  if (!existsSync(source)) return;
  mkdirSync(join(to, 'images'), { recursive: true, mode: 0o700 });
  for (const name of readdirSync(source)) if (!existsSync(join(to, 'images', name))) copyFileSync(join(source, name), join(to, 'images', name));
}

/** Marks a branch closed after its last merge. Its folder stays: it holds the branch's subagent runs and transcripts. */
export function closeInfo(dir: string, info: BranchInfo) { info.closed = new Date().toISOString(); delete info.closing; saveInfo(dir, info); }

/** Merges the branches whose Pi is gone without closing them, as interrupted (or as closed, if they were closing). Inputs and
 * reports they journaled but never logged are logged first, so nothing typed is lost. Returns the ids it merged. */
export async function recoverBranches(profile: string, warn: (text: string) => void = console.error) {
  const recovered: string[] = [];
  for (const listed of listBranches(profile)) {
    if (listed.closed) continue;
    // A lock only proves something about processes on this machine: a branch another host runs (a shared folder) is left to it.
    if (listed.host !== hostname()) { warn(`Branch ${listed.id} runs on ${listed.host}; only a Pi there can merge it if it crashed.`); continue; }
    const dir = branchDirectory(profile, listed.id);
    let release: (() => Promise<void>) | undefined;
    // Taking its lock both proves its process is gone and keeps another Pi from recovering it at the same time.
    try { release = await takeLock(liveLock(dir), describe(`recovering branch ${listed.id}`)); } catch { continue; }
    try {
      // It may have closed between the listing and the lock.
      const info = readInfo(dir);
      if (!info || info.closed) continue;
      const store = new BranchStore(profile, dir, info.base, warn), saved = await store.load();
      const entries = saved.entries.filter(isEntry).sort((a, b) => a.i - b.i);
      let next = entries.length;
      const known = new Set(entries.map(e => e.receipt));
      const log = (kind: Kind, text: string, date: string, receipt: string) => {
        if (known.has(receipt)) return;
        const entry: Entry = { i: next++, kind, text, date, size: bytes(`${kind}: ${text}`), receipt };
        store.append(entry); entries.push(entry); known.add(receipt);
      };
      for (const item of journal(join(dir, 'pending-inputs.json'))) if (typeof item.id === 'string') log('user', String(item.text), String(item.date), item.id);
      for (const item of journal(join(dir, 'pending-reports.json'))) {
        const text = typeof item === 'string' ? item : String(item.text);
        log('work', text, new Date().toISOString(), reportReceipt(text));
      }
      // Notes other sessions left that the branch never got to log. Taking them moves the read mark, and each note's receipt keeps
      // one it logged before the mark moved from going in twice.
      const notes = peekNotes(dir, warn);
      for (const note of notes.notes) log('note', notesText([note]), note.date, noteReceipt(note));
      notes.commit();
      await mergeBranch(profile, dir, info, entries, saved.tree.filter(isNode), info.closing ? 'close' : 'interrupted', warn);
      for (const name of ['pending-inputs.json', 'pending-reports.json']) if (existsSync(join(dir, name))) writeFileSync(join(dir, name), '[]');
      closeInfo(dir, info);
      recovered.push(info.id);
    } catch (error) { warn(`Could not recover branch ${listed.id}: ${error instanceof Error ? error.message : String(error)}`); }
    finally { await release(); }
  }
  return recovered;
}
/** A journal's items. One that can't be read stops the recovery instead of being taken as empty, so nothing in it is lost. */
function journal(file: string): Record<string, unknown>[] {
  if (!existsSync(file)) return [];
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(value)) throw new Error(`${file} is not a list.`);
  return value.map(v => record(v) ? v : { text: String(v) });
}
const isNode = (value: unknown): value is Summary => record(value) && Number.isSafeInteger(value.l) && Number.isSafeInteger(value.i) && typeof value.text === 'string';

/** Archives a branch's own log after a rebase merged all of it: the branch goes on from the trunk's new end. */
export function resetBranch(dir: string, info: BranchInfo, base: number, view: string | undefined) {
  const archive = join(dir, 'rebased', `${info.base}`);
  mkdirSync(archive, { recursive: true, mode: 0o700 });
  for (const name of ['main', 'tree', 'view.json']) if (existsSync(join(dir, name))) renameSync(join(dir, name), join(archive, name));
  info.base = base; saveInfo(dir, info);
  if (view !== undefined) atomicWrite(join(dir, 'view.json'), view);
}

/** The trunk's length and saved view, read under its lock. */
export async function trunkState(profile: string, warn: (text: string) => void = console.error) {
  return withLock(trunkLock(profile), describe('reading the trunk'), () => {
    const trunk = readTrunk(profile, warn);
    return { length: trunk.entries.length, view: trunk.saved.view, foreign: (id: string, from: number) => trunk.entries.slice(from).some(e => e.branch?.id !== id) };
  });
}

/** Appends a line to a file another process reads, as one write. */
export function appendLine(file: string, value: unknown) { appendFileSync(file, JSON.stringify(value) + '\n', { mode: 0o600 }); }

/** Opens a branch's memory. */
export async function openBranchMemory(profile: string, dir: string, info: BranchInfo, compress: Compressor, warn: (text: string) => void, budget?: number, jobs?: number) {
  const store = new BranchStore(profile, dir, info.base, warn);
  return new Memory({ directory: dir, store, saved: await store.load() }, compress, warn, budget, jobs);
}

/** A subagent run's transcript from another branch of the profile, or from the profile's own `runs/` (before branches): each
 * branch keeps its own runs, so a report merged from one can still be zoomed into from another. Read-only. */
export function otherTranscript(profile: string, id: string) {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) return undefined;
  const folders = [profile, ...listBranches(profile).map(info => branchDirectory(profile, info.id))];
  for (const folder of folders) {
    const file = join(folder, 'runs', `${id}.optchat.json`);
    if (!existsSync(file)) continue;
    try {
      const run: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (record(run) && typeof run.sessionFile === 'string') return sessionMessages(join(folder, 'runs', basename(run.sessionFile)));
    } catch { return undefined; }
  }
  return undefined;
}
