import { EventEmitter } from 'node:events';
import { FileStore, storeFor, type Saved, type Store } from './store.ts';

export const NODE = 512;
export const VIEW = 128_000;
export const CAP = 30_000;
/** The most characters of one message a leaf sends the compactor, so a huge paste can't overflow it; zoom still pages through all of it. */
export const SOURCE = 100_000;
/** The most characters one zoom into a message returns, so a page stays under the tool output CAP instead of losing its middle. */
export const PAGE = 25_000;
export const KINDS = ['user', 'talk', 'tool', 'echo', 'note', 'work'] as const;
export type Kind = typeof KINDS[number];
export interface Origin { source: 'claude' | 'claude-memory' | 'codex' | 'pi' | 'chatgpt'; conversation: string; message: string; title: string; project?: string }
/** `branch`: the session a merged message came from, and its index there (see src/branch.ts). */
export interface Entry { i: number; kind: Kind; text: string; size: number; date: string; receipt?: string; origin?: Origin; branch?: { id: string; i: number } }
export interface Part { l: number; i: number }
export interface Summary extends Part { text: string; size: number }
/** `part` is the node to build: a message's leaf, or the merge of its two halves. `call` is the tool call a tool result's leaf
 * answers, raw, since its own line is often not built yet (#153). */
export interface Compression { context: string; source: string; part: Part; historical?: boolean; call?: { i: number; text: string } }
export type Compressor = (input: Compression, signal: AbortSignal) => Promise<string>;
/** A compressor throws this when the model itself gives no line for an input (a refusal, an empty reply, 5 cut-off replies):
 * asked again it fails alike, so the node keeps the start of its source instead of being retried forever (#193). */
export class Refused extends Error {}
const key = ({ l, i }: Part) => l * 2 ** 40 + i;
const UNBUILT = '(not summarized yet: zoom it)';
const CLIPPED = '(not summarized: zoom it)';
export const start = ({ l, i }: Part) => i * 2 ** l;
export const end = (part: Part) => start(part) + 2 ** part.l;
export const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const UNBUILT_BYTES = bytes(UNBUILT);
export const flat = (s: string) => s.replace(/[\r\n]+/g, ' ');
/** The first NODE bytes, without a split character at the end. */
export const cut = (s: string) => Buffer.from(s).subarray(0, NODE).toString('utf8').replace(/\uFFFD+$/, '');
const lineBytes = (s: string) => bytes(flat(s));
const notice = (omitted: number) => `\n[${omitted} characters omitted; head and tail retained]\n`;
const VIEW_OPEN = '<chat>\n';
const VIEW_FRAME_BYTES = bytes(`${VIEW_OPEN}</chat>`);
export const isView = (text: string) => text.startsWith(VIEW_OPEN);
export function cap(text: string, limit = CAP) {
  if (text.length <= limit) return text;
  const half = Math.floor((limit - notice(text.length).length) / 2);
  const head = text.slice(0, /[\ud800-\udbff]/.test(text[half - 1]) ? half - 1 : half);
  const tail = text.slice(/[\udc00-\udfff]/.test(text[text.length - half]) ? text.length - half + 1 : text.length - half);
  return head + notice(text.length - head.length - tail.length) + tail;
}
/** The index of the view's most due pair of sibling lines whose parent is built, or -1 (recipe §3.2). A pair is as due as
 * long ago it ended, in its own line size; equal pairs go oldest first. This is the order of Taelin's rollback push. */
export function mostDue(view: readonly Part[], total: number, built: (part: Part) => boolean) {
  let best = -1, due = -Infinity;
  for (let j = 0; j + 1 < view.length; j++) {
    const a = view[j], b = view[j + 1];
    if (a.l !== b.l || a.i % 2 || b.i !== a.i + 1) continue;
    const age = (total - (end(b) - 1)) / 2 ** a.l;
    if (age > due && built({ l: a.l + 1, i: a.i / 2 })) { best = j; due = age; }
  }
  return best;
}
/** A view (recipe §3.2): lines that tile the log, oldest first. It grows a line per message and, once over `high` bytes or when
 * forced, merges its most due pairs in one batch down to `low`, merging what it can at each change until then. */
class Sawtooth {
  readonly parts: Part[] = [];
  private measured = 0;
  merging = false;
  /** Batches started since this view was opened: each rewrites the view, so its cached prefix is gone. */
  batches = 0;
  constructor(private readonly high: number, private readonly low: number, private readonly node: (part: Part) => Summary | undefined) {}
  private lineSize(part: Part) { return bytes(`${start(part)}+${2 ** part.l}|\n`) + (this.node(part)?.size ?? UNBUILT_BYTES); }
  get size() { return VIEW_FRAME_BYTES + this.measured + (this.parts.length ? 0 : 1); } // render() keeps a blank line in an empty view.
  push(part: Part) { this.parts.push(part); this.measured += this.lineSize(part); }
  /** The line covering message `at`. The lines tile the log in order, so a binary search finds it. */
  covering(at: number): Part | undefined {
    for (let lo = 0, hi = this.parts.length - 1; lo <= hi;) {
      const mid = (lo + hi) >> 1, p = this.parts[mid];
      if (end(p) <= at) lo = mid + 1;
      else if (start(p) > at) hi = mid - 1;
      else return p;
    }
  }
  /** A message got its node. Its line is usually still shown, but after a damaged tree file a saved parent can already hide it. */
  built(i: number) { if (this.covering(i)?.l === 0) this.measured += this.node({ l: 0, i })!.size - UNBUILT_BYTES; }
  /** Returns whether any lines merged. */
  fit(total: number, force = false) {
    const lines = this.parts.length;
    if ((force || this.size > this.high) && !this.merging) { this.merging = true; this.batches++; }
    for (let best: number; this.merging && this.size > this.low && (best = mostDue(this.parts, total, part => !!this.node(part))) >= 0;) {
      const a = this.parts[best], b = this.parts[best + 1], parent = { l: a.l + 1, i: a.i / 2 };
      this.measured += this.lineSize(parent) - this.lineSize(a) - this.lineSize(b);
      this.parts.splice(best, 2, parent);
    }
    if (this.size <= this.low) this.merging = false;
    return this.parts.length < lines;
  }
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
export function isEntry(value: unknown): value is Entry {
  return object(value) && Number.isSafeInteger(value.i) && typeof value.kind === 'string'
    && KINDS.some(kind => kind === value.kind)
    && typeof value.text === 'string' && typeof value.date === 'string';
}
function isSummary(value: unknown): value is Summary {
  return object(value) && Number.isSafeInteger(value.l) && Number.isSafeInteger(value.i)
    && typeof value.text === 'string';
}

/** The log is authoritative. The tree and the view follow the recipe: the view grows a line per message and, once it passes
 * `budget`, merges its most due pairs in one batch down to half of it, so between batches it only grows at its end.
 * Compactions get their own view (recipe §4): the chat's merged further, to between an eighth and a quarter of the budget,
 * and again whenever the chat's merges, so parallel compactions read it from the cache. */
export class Memory {
  readonly root: Entry[] = [];
  readonly tree = new Map<number, Summary>();
  private readonly events = new EventEmitter();
  private readonly controller = new AbortController();
  private readonly busy = new Map<number, Promise<void>>();
  private readonly retryAt = new Map<number, number>();
  private readonly reported = new Set<number>();
  /** Messages without their node, and merges whose halves are built, oldest first, so the scheduler never scans the tree for work (recipe §4). */
  private readonly unbuilt = new Set<number>();
  private readonly merges = new Map<number, Part>();
  private retryTimer?: ReturnType<typeof setTimeout>;
  /** The most summaries owed at once since none were last owed. */
  private peak = 0;
  private scheduled = false;
  private stopped = false;
  private readonly chat: Sawtooth;
  private readonly compaction: Sawtooth;
  /** The last store write still running, if any. Once an append fails, later writes are skipped and appends throw, as after a failed file write. */
  private writing?: Promise<void>;
  private failed?: string;
  /** Where this memory's local files live: all of it for a FileStore, and the browser page, runs and imports for any store. */
  readonly directory: string;
  readonly store: Store;
  lastError?: string;

  /** Opens the memory in `directory` through the store `storeFor` picks, after its load. */
  static async open(directory: string, compress: Compressor, warn: (s: string) => void = console.error, budget = VIEW, jobs = 8) {
    const store = storeFor(directory, warn);
    return new Memory({ directory, store, saved: await store.load() }, compress, warn, budget, jobs);
  }
  /** A directory alone opens a FileStore there. `jobs`: summaries built at once, and how many unbuilt lines a new message's node
   * waits behind. Chat and imports pass the "Summaries at once" setting. */
  constructor(source: string | { directory: string; store: Store; saved: Saved }, private readonly compress: Compressor,
    private readonly warn: (s: string) => void = console.error,
    readonly budget = VIEW, private readonly jobs = 8, private readonly retryMs = 10_000) {
    this.chat = new Sawtooth(budget, budget / 2, part => this.node(part));
    this.compaction = new Sawtooth(budget / 4, budget / 8, part => this.node(part));
    let saved: Saved;
    if (typeof source === 'string') { const store = new FileStore(source, warn); this.directory = source; this.store = store; saved = store.load(); }
    else ({ directory: this.directory, store: this.store, saved } = source);
    const log = saved.entries;
    const entries = log.every(isEntry) ? log.sort((a, b) => a.i - b.i) : undefined;
    if (!entries || entries.some((entry, i) => entry.i !== i)) throw new Error('Invalid/noncontiguous OptChat log; refusing to change it.');
    for (const value of entries) this.root.push({ ...value, size: bytes(`${value.kind}: ${value.text}`) });
    for (const value of saved.tree) {
      if (!isSummary(value) || value.l < 0 || value.i < 0 || end(value) > this.root.length)
        throw new Error('Invalid OptChat summary record.');
      this.tree.set(key(value), { ...value, size: lineBytes(value.text) });
    }
    for (const node of this.tree.values()) this.queueParent(node);
    for (let i = 0; i < this.root.length; i++) if (!this.node({ l: 0, i })) this.unbuilt.add(i);
    // Refolding the log gives different views than the live ones, and every cache entry would miss, so the views are saved.
    const loaded = this.load(saved.view);
    for (let i = loaded; i < this.root.length; i++) { this.push(i); this.fit(i + 1); }
    this.fit(); this.save(); this.schedule();
  }
  append(kind: Kind, text: string, date = new Date().toISOString(), receipt?: string, origin?: Origin) {
    if (this.stopped) throw new Error('Memory is closed.');
    if (this.failed) throw new Error(`Memory could not be saved: ${this.failed}`);
    const entry: Entry = { i: this.root.length, kind, text, date, size: bytes(`${kind}: ${text}`), ...(receipt ? { receipt } : {}), ...(origin ? { origin } : {}) };
    void this.enqueue(() => this.store.append(entry), error => {
      this.failed ??= error instanceof Error ? error.message : String(error);
      this.warn(`Memory could not be saved: ${this.failed}`);
    });
    this.root.push(entry); this.push(entry.i); if (this.fit()) this.save(); this.schedule();
    return entry;
  }
  node(part: Part) { return this.tree.get(key(part)); }
  private text(part: Part) { return this.node(part)?.text ?? UNBUILT; }
  /** Runs a store write at once when none is running, so a store that finishes its writes as it returns (FileStore) throws here
   * as before; otherwise after the running ones, so writes land in the order Memory makes them. Returns the queued write, settled
   * through `failed`, unless it finished at once. */
  private enqueue(write: () => Promise<void> | undefined, failed: (error: unknown) => void) {
    const run = () => this.failed ? undefined : write();
    const started = this.writing ? this.writing.then(run) : run();
    if (!started) return;
    const settled = started.catch(failed);
    const tail: Promise<void> = settled.catch(() => {}).then(() => { if (this.writing === tail) this.writing = undefined; });
    this.writing = tail;
    return settled;
  }
  /** Takes the saved views if they still tile the log from the start, and returns how many messages they cover. */
  private load(view: string | undefined) {
    if (view === undefined) return 0;
    let saved: unknown;
    try { saved = JSON.parse(view); } catch { saved = undefined; }
    const chat = this.tiling(saved);
    if (!chat) { this.warn('Rebuilt the memory view: the saved one does not match the log.'); return 0; }
    for (const part of chat.parts) this.chat.push(part);
    this.chat.merging = chat.merging;
    // An older view.json has only the chat's view: the compactions' is refolded from it, a cold prefix once.
    const compaction = object(saved) ? this.tiling(saved.compaction) : undefined;
    if (compaction?.covered === chat.covered) { for (const part of compaction.parts) this.compaction.push(part); this.compaction.merging = compaction.merging; }
    else { for (const part of chat.parts) this.compaction.push(part); this.compaction.fit(chat.covered, true); }
    return chat.covered;
  }
  /** A saved view, `{ parts, merging }` or an older bare list of parts, if it tiles the log from the start. */
  private tiling(saved: unknown) {
    const merging = object(saved) && saved.merging === true;
    if (object(saved) && typeof saved.merging === 'boolean') saved = saved.parts;
    if (!Array.isArray(saved)) return;
    const parts: Part[] = [];
    let covered = 0;
    for (const value of saved) {
      const [l, i] = Array.isArray(value) ? value : [];
      const part = { l, i };
      if (!Number.isSafeInteger(l) || !Number.isSafeInteger(i) || l < 0 || start(part) !== covered || end(part) > this.root.length || (l > 0 && !this.node(part)))
        return;
      parts.push(part); covered = end(part);
    }
    return { parts, merging, covered };
  }
  /** Saved when either view merges or changes batch state: a view that only grew is the saved one plus later messages, as `load`
   * replays it. The log stays authoritative, so a failed save only warns. */
  private save() {
    const failed = (error: unknown) => { this.warn(`Could not save the memory view: ${error instanceof Error ? error.message : String(error)}`); };
    const saved = ({ parts, merging }: Sawtooth) => ({ parts: parts.map(p => [p.l, p.i]), merging });
    try { void this.enqueue(() => this.store.saveView(JSON.stringify({ ...saved(this.chat), compaction: saved(this.compaction) })), failed); }
    catch (error) { failed(error); }
  }
  private push(i: number) {
    const part = { l: 0, i };
    this.chat.push(part); this.compaction.push(part);
    if (!this.node(part)) this.unbuilt.add(i);
  }
  get view(): readonly Part[] { return this.chat.parts; }
  render() { return `${VIEW_OPEN}${this.view.map(p => `${start(p)}+${2 ** p.l}|${flat(this.text(p))}`).join('\n')}\n</chat>`; }
  get ready() { return this.view.every(p => this.node(p)); }
  get pending() { return this.unbuilt.size; }
  get active() { return this.busy.size; }
  get size() { return this.chat.size; }
  /** Batch merges the chat's view has started since this memory opened. */
  get batches() { return this.chat.batches; }
  /** Summaries built out of the backlog since it was last empty, and when the next failed one is retried. */
  progress(now = Date.now()) {
    const due = Math.min(...[...this.retryAt.values()].filter(t => t > now));
    return { done: this.peak - this.owed(), total: this.peak, retryIn: Number.isFinite(due) ? due - now : undefined };
  }
  private owed() { return this.expectedNodes() - this.tree.size; }
  onChange(listener: () => void) { this.events.on('change', listener); return () => { this.events.off('change', listener); }; }
  /** The view line covering message `at`. */
  covering(at: number) { return this.chat.covering(at); }
  /** Returns whether either view, or its batch state, changed. */
  private fit(total = this.root.length) {
    const merging = [this.chat.merging, this.compaction.merging];
    const merged = this.chat.fit(total);
    const compacted = this.compaction.fit(total, merged);
    const owed = this.owed();
    this.peak = owed > 0 ? Math.max(this.peak, owed) : 0;
    this.events.emit('change');
    return merged || compacted || merging[0] !== this.chat.merging || merging[1] !== this.compaction.merging;
  }
  private schedule() {
    if (this.scheduled || this.stopped) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.pump(); });
  }
  private pump() {
    if (this.stopped) return;
    // One clock reading: skipping a part and arming its retry timer must agree on what is due.
    const now = Date.now();
    const run = (part: Part) => {
      const id = key(part);
      if (this.busy.has(id) || (this.retryAt.get(id) ?? 0) > now) return;
      const promise = this.build(part).catch(error => {
        if (this.stopped) return;
        this.lastError = error instanceof Error ? error.message : String(error);
        if (!this.reported.has(id)) { this.reported.add(id); this.warn(`Compactor ${start(part)}+${2 ** part.l}: ${this.lastError}`); }
        this.retryAt.set(id, Date.now() + this.retryMs);
        if (!this.retryTimer) this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.schedule(); }, this.retryMs);
      // Schedule before telling waiters, so a turn never mistakes the gap before the next pump for a stall.
      }).finally(() => { this.busy.delete(id); this.schedule(); this.events.emit('change'); });
      this.busy.set(id, promise);
    };
    // A message's node starts once fewer than `jobs` lines before it are unbuilt; a merge, once both halves are built. They start
    // in the order of the context they end at, a merge first at a tie, as Unii's do (#194): messages first left the merges waiting
    // through a backlog, so the views ran over budget and changed at every node built, and compactions read about 60% from the cache.
    const ready: Part[] = [];
    for (const i of this.unbuilt) { if (ready.length === this.jobs) break; ready.push({ l: 0, i }); }
    const at = (part: Part) => part.l ? end(part) : part.i;
    for (const part of [...ready, ...this.merges.values()].sort((a, b) => at(a) - at(b) || b.l - a.l)) {
      if (this.busy.size >= this.jobs) return;
      run(part);
    }
    // A later failure can have a later deadline than the timer installed by the first.
    const deadlines = [...this.retryAt.values()].filter(t => t > now);
    if (deadlines.length && !this.retryTimer) this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.schedule(); }, Math.max(1, Math.min(...deadlines) - now));
    if (this.stalled) this.events.emit('change');
  }
  /** Nothing is being built, nothing more can start, and something failed: only a retry can make progress. */
  private get stalled() { return this.busy.size === 0 && !this.scheduled && this.retryAt.size > 0; }
  private async build(part: Part) {
    const source = part.l === 0 ? `${this.root[part.i].kind}: ${this.root[part.i].text}`
      : [0, 1].map(offset => this.text({ l: part.l - 1, i: 2 * part.i + offset })).join('\n');
    const mergeSource = part.l > 0 ? [0, 1].map(offset => flat(this.text({ l: part.l - 1, i: 2 * part.i + offset }))).join('\n') : source;
    const call = part.l === 0 ? this.callOf(part.i) : undefined;
    let text = source;
    if (bytes(source) > NODE) try {
      text = (await this.compress({ context: this.compactionView(part), source: cap(mergeSource, SOURCE), part,
        historical: this.root.slice(start(part), end(part)).some(entry => !!entry.origin),
        ...(call ? { call: { i: call.i, text: cap(`tool: ${call.text}`, 4000) } } : {}) }, this.controller.signal)).trim();
      if (!text) throw new Refused('Compactor returned an empty summary.');
    } catch (error) {
      if (!(error instanceof Refused) || this.stopped) throw error;
      text = cut(`${CLIPPED} ${flat(mergeSource)}`);
      this.warn(`Compactor ${start(part)}+${2 ** part.l}: ${error.message} (kept its start instead)`);
    }
    if (this.stopped) return;
    const node = { ...part, text, size: lineBytes(text) };
    // A failed node write fails the build, which is retried.
    const written = this.enqueue(() => this.store.appendNode(node), error => { throw error; });
    if (written) await written;
    this.tree.set(key(part), node); this.retryAt.delete(key(part)); this.merges.delete(key(part)); this.queueParent(part);
    if (!part.l) { this.unbuilt.delete(part.i); this.chat.built(part.i); this.compaction.built(part.i); }
    if (!this.retryAt.size) this.lastError = undefined;
    if (this.fit()) this.save();
  }
  /** The tool call a result answers: a run of calls is followed by their results in the same order. A result that doesn't
   * start with the call's tool name (an `Agent error`, an odd import) has none. */
  private callOf(i: number) {
    if (this.root[i].kind !== 'echo') return;
    let results = i;
    while (this.root[results - 1]?.kind === 'echo') results--;
    let calls = results;
    while (this.root[calls - 1]?.kind === 'tool') calls--;
    const call = calls + i - results < results ? this.root[calls + i - results] : undefined;
    return call && this.root[i].text.startsWith(`${call.text.split(' ', 1)[0]}:`) ? call : undefined;
  }
  /** The compactions' view up to the node. A line still being built shows as a placeholder instead of ending the view: an A/B on
   * real turns (#101) found that cutting there also hid the built lines after it, such as an echo's own tool call. */
  private compactionView(part: Part) {
    const boundary = part.l === 0 ? start(part) : end(part), lines: string[] = [];
    for (const p of this.compaction.parts) { if (end(p) > boundary) break; lines.push(`${start(p)}+${2 ** p.l}|${flat(this.text(p))}`); }
    return `${VIEW_OPEN}${lines.join('\n')}\n</chat>`;
  }
  private queueParent({ l, i }: Part) {
    const parent = { l: l + 1, i: Math.floor(i / 2) };
    if (!this.node(parent) && this.node({ l, i: i % 2 ? i - 1 : i + 1 })) this.merges.set(key(parent), parent);
  }
  /** A 'turn' waits until every part of the view is built, or until everything pending has failed: it then goes on with placeholders
   * for the missing lines, `lastError` says why, and the failed nodes are still retried in the background. 'tree' waits for every
   * node, through failures. As in the recipe, the view may run over budget until pending merges land.
   * 'ahead' (imports) waits until a new message's node would start at once. Due merges count too: messages go first, so a steady
   * stream of them would otherwise take every worker and the views could never merge. */
  async settle(signal?: AbortSignal, until: 'turn' | 'tree' | 'ahead' = 'turn'): Promise<void> {
    const done = () => until === 'tree' ? this.ready && this.busy.size === 0 && this.tree.size === this.expectedNodes()
      : until === 'ahead' ? this.unbuilt.size + this.merges.size < this.jobs
      : this.ready || this.stalled;
    if (done()) return;
    if (this.stopped || signal?.aborted) throw new Error('Memory wait cancelled.');
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { this.events.off('change', check); signal?.removeEventListener('abort', abort); };
      const abort = () => { cleanup(); reject(new Error('Memory wait cancelled.')); };
      const check = () => { if (this.stopped) abort(); else if (done()) { cleanup(); resolve(); } };
      this.events.on('change', check); signal?.addEventListener('abort', abort, { once: true }); check();
    });
  }
  private expectedNodes() {
    let count = 0;
    for (let n = this.root.length; n > 0; n = Math.floor(n / 2)) count += n;
    return count;
  }
  /** n = 1 gives the message whole, or, when it is longer than `limit` or `offset` is given, the page of up to `limit` characters from `offset`.
   * Paging a message that fits in one page is allowed, but the page says so. */
  zoom(id: number, n: number, offset?: number, limit?: number) {
    if (!Number.isSafeInteger(id) || id < 0 || !Number.isSafeInteger(n) || n < 1 || !Number.isInteger(Math.log2(n)) || id % n || id + n > this.root.length)
      throw new Error(`No line ${id}+${n}: n is a power of 2, id a multiple of n. The tree's roots: ${this.roots() || 'none, the chat is empty'}.`);
    if (n === 1) {
      const { kind, text } = this.root[id], page = Math.min(limit ?? PAGE, PAGE);
      if (!Number.isSafeInteger(page) || page < 1) throw new Error('limit must be a positive integer.');
      if (offset === undefined && text.length <= page) return `${id}+1|${kind}: ${text}`;
      if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0 || offset >= Math.max(1, text.length)))
        throw new Error(`Message ${id} has ${text.length} characters; offset must be 0 to ${Math.max(0, text.length - 1)}.`);
      // Never split a surrogate pair: a page starts on its first half and ends after its second.
      const from = /[\udc00-\udfff]/.test(text[offset ?? 0] ?? '') ? (offset ?? 0) - 1 : offset ?? 0;
      let to = Math.min(text.length, from + page);
      // A one-unit page on a pair takes the whole pair, so the next offset always moves forward.
      if (to < text.length && /[\ud800-\udbff]/.test(text[to - 1])) to += to - 1 === from ? 1 : -1;
      const hint = text.length <= PAGE ? `\n[note: this message is only ${text.length.toLocaleString('en-US')} characters and fits in one zoom; offset/limit are for messages over ${PAGE.toLocaleString('en-US')}]` : '';
      return `${id}+1|${kind}: ${text.slice(from, to)}\n[showing characters ${from}-${to} of ${text.length}${to < text.length ? `; next page: offset ${to}` : ''}]${hint}`;
    }
    if (offset !== undefined) throw new Error('offset and limit page one message: use them with n = 1.');
    const l = Math.log2(n) - 1, i = 2 * id / n;
    // A half not built yet shows as in the view, so the other half still comes back.
    return [0, 1].map(offset => {
      const part = { l, i: i + offset };
      return `${start(part)}+${2 ** l}|${flat(this.text(part))}`;
    }).join('\n');
  }
  /** The largest whole lines covering the chat, oldest first: one per power of two in the message count. */
  private roots() {
    const lines: string[] = [];
    for (let id = 0, n = 2 ** Math.floor(Math.log2(this.root.length || 1)); n >= 1; n /= 2)
      if (id + n <= this.root.length) { lines.push(`${id}+${n}`); id += n; }
    return lines.join(', ');
  }
  /** Original messages containing `text`, ignoring case, newest first, older than message `before`. Never summaries,
   * nor the logged zoom/search calls and results, which only copy memory. */
  search(text: string, before = this.root.length) {
    const needle = text.toLowerCase(), hits: Entry[] = [];
    for (let i = Math.min(before, this.root.length) - 1; i >= 0; i--) {
      const entry = this.root[i];
      if ((entry.kind === 'tool' || entry.kind === 'echo') && /^(zoom|search)[ :]/.test(entry.text)) continue;
      if (entry.text.toLowerCase().includes(needle)) hits.push(entry);
    }
    return hits;
  }
  date(id: number) {
    if (!Number.isSafeInteger(id) || !this.root[id]) throw new Error(`No message ${id}.`);
    return new Date(this.root[id].date).toString();
  }
  async close() {
    this.stopped = true; this.controller.abort(); clearTimeout(this.retryTimer);
    this.events.emit('change'); await Promise.allSettled(this.busy.values()); await this.writing;
  }
}
