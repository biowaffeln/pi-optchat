import { isView } from './memory.ts';
import { AT_WORK } from './prompts.ts';

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The view in blocks of 4 lines counted from its start (recipe §3.3), byte for byte. While the view only grows at its end,
 * every block but the last is the same in the next call. */
export function splitView(text: string) {
  const pieces: string[] = [];
  let offset = 0;
  for (let count = 0, at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1))
    if (++count % 4 === 0) { pieces.push(text.slice(offset, at + 1)); offset = at + 1; }
  pieces.push(text.slice(offset));
  return pieces;
}

/** How many blocks before the view's last whole one each mark sits. Anthropic looks back only 20 blocks from a mark for an
 * earlier entry, so the mark 20 blocks back still finds the last call's entry after a turn of tool calls adds up to 40 blocks
 * (160 lines), and one 40 back up to 60 blocks (240 lines). Anthropic takes 4 marks: the system prompt gets one, so a view
 * written anew (a batch merge, a new session) writes only itself, as in the recipe; a turn's end gets one; the view gets the
 * rest, so a turn marks 0 and 20 back, and a compaction, whose end is unmarked, 0, 20 and 40 back. */
const MARKS = [0, 20, 40];
const LIMIT = 4;

/** The status line's own message, in Pi's context and in Anthropic's payload alike. */
export const isAtWork = (message: unknown) => record(message) && message.role === 'user' && Array.isArray(message.content) && message.content.length === 1
  && record(message.content[0]) && typeof message.content[0].text === 'string' && message.content[0].text.startsWith(AT_WORK);
function lastBlock(message: Record<string, unknown>) {
  if (typeof message.content === 'string') message.content = [{ type: 'text', text: message.content }];
  const block: unknown = Array.isArray(message.content) ? message.content.at(-1) : undefined;
  return record(block) ? block : undefined;
}

/** Anthropic: marks on the view (see MARKS) plus a mark at the end of the request, so the next call finds the last one's entry
 * and pays only for the lines after it. The end mark sits on the last block itself rather than as top-level automatic caching:
 * a proxy or setting that gives block marks a 1h TTL makes Anthropic refuse a top-level mark, whose TTL defaults to 5m, on the
 * same block ("Top-level cache_control has ttl='5m' but the target block already has cache_control with ttl='1h'").
 * `end: false` leaves the end unmarked: a compaction's task is never sent again, so marking it would only write it at 1.25× (#197). */
export function cachePayload(payload: unknown, { end: markEnd = true } = {}): unknown {
  if (!record(payload) || !Array.isArray(payload.messages)) return payload;
  const messages = payload.messages;
  const view = new Set<unknown>();
  for (const message of messages) {
    if (!record(message) || message.role !== 'user' || !Array.isArray(message.content)) continue;
    const at = message.content.findIndex((block: unknown) => record(block) && block.type === 'text' && typeof block.text === 'string' && isView(block.text));
    if (at < 0) continue;
    // A subagent's task follows the view in the same text. Lines never hold a newline, so the first one before </chat> ends the view;
    // the task goes in its own block, so the view's marks fall on lines its siblings share and they can read one another's entry.
    const text: string = message.content[at].text, close = text.indexOf('\n</chat>'), end = close < 0 ? text.length : close + '\n</chat>'.length;
    const spare = LIMIT - (systemBlock(payload) ? 1 : 0) - (markEnd ? 1 : 0);
    const pieces = splitView(text.slice(0, end)), marked = new Set(MARKS.slice(0, spare).map(back => pieces.length - 2 - back));
    const blocks = pieces.map((text, j) => ({ type: 'text', text, ...(marked.has(j) ? { cache_control: { type: 'ephemeral' } } : {}) }));
    message.content.splice(at, 1, ...blocks, ...(end < text.length ? [{ type: 'text', text: text.slice(end) }] : []));
    for (const block of blocks) view.add(block);
    break;
  }
  if (!view.size) return payload;
  // These marks only: Pi's own system, tool and recent-message marks are dropped, and the system prompt's last block gets ours,
  // which covers the tools too (they come first in Anthropic's prefix).
  for (const section of [payload.system, payload.tools]) {
    if (Array.isArray(section)) for (const item of section) if (record(item)) delete item.cache_control;
  }
  const system = systemBlock(payload);
  if (system) system.cache_control = { type: 'ephemeral' };
  for (const message of messages) {
    if (!record(message)) continue;
    delete message.cache_control;
    if (Array.isArray(message.content)) for (const item of message.content) if (record(item) && !view.has(item)) delete item.cache_control;
  }
  // The status line changes between calls, so the turn's mark goes on the block before it rather than at the end of the request.
  // Pi may end the request with an empty system message carrying settings (effort); it holds nothing to cache.
  const [before, last] = messages.filter(message => !record(message) || message.role !== 'system').slice(-2);
  const turn = isAtWork(last) && record(before) && before.role === 'user' ? lastBlock(before) : undefined;
  const end = markEnd ? turn ?? endBlock(messages) : undefined;
  if (end) end.cache_control = { type: 'ephemeral' };
  return payload;
}

/** The system prompt's last block, made a block list first if it was sent as a string. None for an empty prompt. */
function systemBlock(payload: Record<string, unknown>) {
  if (typeof payload.system === 'string') payload.system = payload.system ? [{ type: 'text', text: payload.system }] : undefined;
  const block: unknown = Array.isArray(payload.system) ? payload.system.at(-1) : undefined;
  return record(block) && block.type === 'text' && typeof block.text === 'string' && block.text ? block : undefined;
}

/** The last block of the last non-system message that can carry a mark (thinking blocks can't). */
function endBlock(messages: unknown[]) {
  const message = messages.filter(m => !record(m) || m.role !== 'system').at(-1);
  if (!record(message)) return undefined;
  if (typeof message.content === 'string') return lastBlock(message);
  if (!Array.isArray(message.content)) return undefined;
  const block: unknown = message.content.findLast((b: unknown) => record(b) && b.type !== 'thinking' && b.type !== 'redacted_thinking');
  return record(block) ? block : undefined;
}
