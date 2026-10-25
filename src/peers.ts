import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { appendLine, branchDirectory, listBranches, liveStatus } from './branch.ts';
import { cachePayload, record } from './cache.ts';
import { reasoningFor, retryTransient, type ModelChoice } from './compactor.ts';
import { bytes, flat } from './memory.ts';
import { ASK_PEER } from './prompts.ts';
import { atomicWrite } from './store.ts';
import { textContent } from './transcript.ts';

// Peers are the other live branches of the same profile (other Pi sessions). A branch publishes what it is doing in two places:
// its live lock answers with a small status (cwd, the last few lines of its view), and `view.txt` in its folder holds its whole
// rendered view, rewritten after each turn. A peer can read both but writes only one thing into another branch: a note, appended
// to that branch's `notes.jsonl`, which it adds to the end of its next input. Nothing here starts a turn or touches a peer's
// memory, log or cache.

/** The most bytes of one note: OptMem's note size. */
export const NOTE_BYTES = 280;
/** How many of a peer's last view lines `peers` shows. */
export const PEER_LINES = 4;
const VIEW_FILE = 'view.txt', NOTES = 'notes.jsonl', READ = 'notes.read';

export interface Note { from: string; cwd: string; text: string; date: string }

/** Rewrites what a live branch shows its peers: its rendered view. */
export function publishView(dir: string, view: string) { atomicWrite(join(dir, VIEW_FILE), view); }
/** The last `count` lines of a rendered view. */
export function lastLines(view: string, count = PEER_LINES) {
  return view.split('\n').filter(line => /^\d+\+\d+\|/.test(line)).slice(-count);
}

/** The other live branches, oldest first, as their locks describe them. */
export async function livePeers(profile: string, self: string) {
  const peers: { id: string; cwd: string; started: string; lines: string[]; working?: boolean }[] = [];
  for (const info of listBranches(profile)) {
    if (info.id === self || info.closed) continue;
    const status = await liveStatus(profile, info.id);
    if (!status) continue;
    const lines = Array.isArray(status.lines) ? status.lines.filter((line): line is string => typeof line === 'string') : [];
    peers.push({ id: info.id, cwd: typeof status.cwd === 'string' ? status.cwd : info.cwd, started: info.created, lines, ...typeof status.working === 'boolean' ? { working: status.working } : {} });
  }
  return peers;
}
export function peersText(peers: Awaited<ReturnType<typeof livePeers>>) {
  if (!peers.length) return 'No other session is open on this profile.';
  return peers.map(p => `${p.id} · ${p.cwd} · started ${new Date(p.started).toString().slice(0, 21)}${p.working === undefined ? '' : p.working ? ' · working' : ' · idle'}\n${p.lines.map(line => `  ${line}`).join('\n') || '  (nothing yet)'}`).join('\n\n');
}

async function livePeer(profile: string, id: string, self: string) {
  if (!/^[0-9a-f]{6}$/.test(id)) throw new Error(`No session ${id}: ids are the 6-character ones peers lists.`);
  if (id === self) throw new Error(`${id} is this session.`);
  if (!await liveStatus(profile, id)) throw new Error(`Session ${id} is not open (anymore). Call peers for the open ones.`);
  return branchDirectory(profile, id);
}

/** Adds a note to the end of a live peer's next input. */
export async function notePeer(profile: string, self: { id: string; cwd: string }, id: string, text: string) {
  const note = flat(text).trim();
  if (!note) throw new Error('The note is empty.');
  if (bytes(note) > NOTE_BYTES) throw new Error(`The note is ${bytes(note)} bytes; notes are at most ${NOTE_BYTES}. Shorten it.`);
  const dir = await livePeer(profile, id, self.id);
  appendLine(join(dir, NOTES), { from: self.id, cwd: self.cwd, text: note, date: new Date().toISOString() } satisfies Note);
}

/** Notes left for this branch since it last took them, oldest first; taking them moves the read mark past them. */
export function takeNotes(dir: string): Note[] {
  const file = join(dir, NOTES);
  if (!existsSync(file)) return [];
  let read = 0;
  try { read = Number(readFileSync(join(dir, READ), 'utf8')) || 0; } catch { read = 0; }
  const size = statSync(file).size;
  if (size <= read) return [];
  const data = readFileSync(file).subarray(read, size), complete = data.lastIndexOf(0x0a) + 1;
  if (!complete) return [];
  const notes = data.subarray(0, complete).toString('utf8').split('\n').flatMap(line => {
    // SAFETY: from and text are checked; cwd and date are only shown.
    try { const value: unknown = JSON.parse(line); return record(value) && typeof value.from === 'string' && typeof value.text === 'string' ? [value as unknown as Note] : []; }
    catch { return []; }
  });
  atomicWrite(join(dir, READ), String(read + complete));
  return notes;
}
/** The notes as they go after the user's input. */
export const notesText = (notes: Note[]) => notes.map(n => `[note from ${n.from} (${n.cwd})] ${n.text}`).join('\n');

/** Asks a cheap model a question about a live peer, from that peer's published view only. */
export async function askPeer(profile: string, self: string, id: string, question: string, registry: ModelRegistry, choice: ModelChoice,
  usage: (message: AssistantMessage) => void, signal?: AbortSignal) {
  const dir = await livePeer(profile, id, self);
  let view: string;
  try { view = readFileSync(join(dir, VIEW_FILE), 'utf8'); } catch { throw new Error(`Session ${id} hasn't published its view yet; ask again after its next turn.`); }
  const model = registry.find(choice.provider, choice.model);
  if (!model) throw new Error(`Model unavailable: ${choice.provider}/${choice.model}. Use /optchat model.`);
  const reply = await retryTransient(() => registry.streamSimple(model, {
    systemPrompt: ASK_PEER,
    messages: [{ role: 'user', timestamp: Date.now(), content: [{ type: 'text', text: view }, { type: 'text', text: `\n\nThe question, from session ${self}:\n${question}` }] }],
  }, {
    reasoning: reasoningFor(model, choice.thinking), maxTokens: Math.min(4000, model.maxTokens), cacheRetention: 'short',
    signal: AbortSignal.any([AbortSignal.timeout(120_000), ...signal ? [signal] : []]),
    // The view is marked like a turn's, so two questions to the same peer in a row read it from the cache.
    onPayload: payload => model.api === 'anthropic-messages' ? cachePayload(payload, { end: false }) : payload,
  }).result(), usage, undefined, signal);
  if (reply.stopReason === 'error' || reply.stopReason === 'aborted') throw new Error(reply.errorMessage ?? reply.stopReason);
  const answer = textContent(reply.content).trim();
  if (!answer) throw new Error('The model gave no answer.');
  return answer;
}
