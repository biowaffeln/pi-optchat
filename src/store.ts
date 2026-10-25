import { closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, truncateSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Entry, Summary } from './memory.ts';

/** The image types memory keeps, and the file extension each is saved under. */
export const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' } as const;
export type Mime = keyof typeof EXTENSIONS;
export const isMime = (mime: string): mime is Mime => Object.hasOwn(EXTENSIONS, mime);
const MIMES = new Map<string, Mime>((Object.keys(EXTENSIONS) as Mime[]).map(mime => [EXTENSIONS[mime], mime]));

/** What a store gives back when a memory opens. Memory validates every record itself; `view` is the JSON `saveView` was last given. */
export interface Saved { entries: unknown[]; tree: unknown[]; view?: string }
/** A write is done when it returns: a store that writes behind returns a promise instead, which Memory awaits in order. */
type Write = Promise<void> | undefined;
type Maybe<T> = T | Promise<T>;

/** Where one memory keeps what travels between machines: its message log, summary nodes, saved view and images. Everything else
 * in a profile (runs, recovery journals, the active-memory pointer and imports, usage, settings, AGENTS.md) stays on the machine.
 * Memory loads once when it opens, then works in RAM and issues every write in order. */
export interface Store {
  load(): Maybe<Saved>;
  /** Appends a message. Throws, writing nothing, if someone else appended since this store loaded. */
  append(entry: Entry): Write;
  /** Appends a summary node. */
  appendNode(node: Summary): Write;
  /** Replaces the saved view. */
  saveView(view: string): Write;
  putImage(name: string, mimeType: Mime, data: Uint8Array): Write;
  image(name: string): Maybe<{ mimeType: Mime; data: Uint8Array } | undefined>;
}

/** The one place a profile's store is chosen. A `store` setting will plug in here; until then every profile keeps its memory in files. */
export const storeFor = (directory: string, warn: (s: string) => void = console.error): Store => new FileStore(directory, warn);

export function localDay(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function atomicWrite(file: string, text: string | Uint8Array) {
  mkdirSync(resolve(file, '..'), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  // One read-write handle: Windows refuses fsync on a read-only one, and it cannot open a directory at all, so there the file flush is the whole guarantee.
  const fd = openSync(temporary, 'w+', 0o600);
  try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, file);
  if (process.platform === 'win32') return;
  const parent = openSync(resolve(file, '..'), 'r');
  try { fsyncSync(parent); } finally { closeSync(parent); }
}
const otherWriter = (file: string) => new Error(`Another process wrote ${file}. Close every other Pi on this profile and restart Pi; nothing was written.`);
/** With `size`, refuses to append unless the file still has that size. A last line left without its newline is ended first. A write
 * cut short is truncated away before the error is thrown. Returns the new size. */
export function appendJson(file: string, value: unknown, size?: number) {
  const fd = openSync(file, 'a+', 0o600);
  try {
    const length = fstatSync(fd).size, last = Buffer.alloc(1);
    if (size !== undefined && length !== size) throw otherWriter(file);
    const torn = length > 0 && readSync(fd, last, 0, 1, length - 1) === 1 && last[0] !== 0x0a;
    const data = Buffer.from((torn ? '\n' : '') + JSON.stringify(value) + '\n');
    // A cut-short write is undone, so the file keeps the size the caller checks against. Windows refuses to truncate through an
    // append handle, so this goes by path; if the undo fails too, the write's own error is still the one thrown.
    try { if (writeSync(fd, data) !== data.length) throw new Error(`Incomplete write: ${file}`); }
    catch (error) { try { truncateSync(file, length); } catch {} throw error; }
    fsyncSync(fd);
    return fstatSync(fd).size;
  } finally { closeSync(fd); }
}
function records(dir: string, warn: (s: string) => void): unknown[] {
  if (!existsSync(dir)) return [];
  const result: unknown[] = [];
  for (const name of readdirSync(dir).filter(n => n.endsWith('.jsonl')).sort()) {
    const file = join(dir, name);
    for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
      if (!line.trim()) continue;
      try { result.push(JSON.parse(line)); }
      catch { warn(`Skipped damaged JSON at ${file}:${index + 1}`); }
    }
  }
  return result;
}

/** Memory as files in one directory: `main/` and `tree/` hold dated JSONL, each line fsynced as it is appended; `view.json` and
 * `images/<hash>.<ext>` are replaced atomically. Every write is done when it returns. */
export class FileStore implements Store {
  /** Each log file's size as this store last left it, so a write by another process is refused instead of interleaved. */
  private readonly lastSeenBytes = new Map<string, number>();
  constructor(readonly directory: string, private readonly warn: (s: string) => void = console.error) {}
  load(): Saved {
    for (const sub of ['main', 'tree']) mkdirSync(join(this.directory, sub), { recursive: true, mode: 0o700 });
    const main = join(this.directory, 'main'), entries = records(main, this.warn);
    for (const name of readdirSync(main).filter(n => n.endsWith('.jsonl'))) this.lastSeenBytes.set(join(main, name), statSync(join(main, name)).size);
    const view = join(this.directory, 'view.json');
    // An unreadable view is rebuilt, as a damaged one is.
    let saved: string | undefined;
    if (existsSync(view)) try { saved = readFileSync(view, 'utf8'); } catch { saved = ''; }
    return { entries, tree: records(join(this.directory, 'tree'), this.warn), view: saved };
  }
  append(entry: Entry): undefined {
    const file = join(this.directory, 'main', `${localDay()}.jsonl`);
    if (!this.lastSeenBytes.has(file)) this.checkLog(file);
    this.lastSeenBytes.set(file, appendJson(file, entry, this.lastSeenBytes.get(file) ?? 0));
  }
  private checkLog(next: string) {
    const main = dirname(next), names = readdirSync(main).filter(n => n.endsWith('.jsonl'));
    if (names.length !== this.lastSeenBytes.size || names.some(n => statSync(join(main, n)).size !== this.lastSeenBytes.get(join(main, n)))) throw otherWriter(next);
  }
  appendNode(node: Summary): undefined { appendJson(join(this.directory, 'tree', `${localDay()}.jsonl`), node); }
  saveView(view: string): undefined { atomicWrite(join(this.directory, 'view.json'), view); }
  putImage(name: string, mimeType: Mime, data: Uint8Array): undefined { atomicWrite(join(this.directory, 'images', `${name}.${EXTENSIONS[mimeType]}`), data); }
  image(name: string) {
    let file: string | undefined;
    try { file = readdirSync(join(this.directory, 'images')).find(f => f.startsWith(`${name}.`) && MIMES.has(f.slice(name.length + 1))); } catch { return undefined; }
    const mimeType = file && MIMES.get(file.slice(name.length + 1));
    return file && mimeType ? { mimeType, data: readFileSync(join(this.directory, 'images', file)) } : undefined;
  }
}
