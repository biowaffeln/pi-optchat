import { createHash } from 'node:crypto';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { getCurrentSystemMessage, type SystemMessage, type UserMessage } from '@earendil-works/pi-ai';
import { CAP, cap, flat, isView, type Memory } from './memory.ts';
import { AT_WORK } from './prompts.ts';
import { record } from './cache.ts';
import { DEFAULT_SETTINGS } from './settings.ts';
import { imageRef, isImage } from './images.ts';

export const RUN_BOUNDARY = 'optchat.run';
/** Subagent traffic to the main agent: a custom message on screen, a plain user message to the model, `work` in memory. */
export const REPORT_TYPE = 'optchat-report';
export const REPORT_RECEIPT = 'report:';
/** A report's receipt in memory: it marks the entry as `work` and keeps a restart from delivering the report twice. */
export const reportReceipt = (text: string) => REPORT_RECEIPT + createHash('sha256').update(text).digest('hex');
/** Notes from other sessions on the profile (src/peers.ts): a custom message shown after the input they came with, a user
 * message to the model that starts "[note from <id> (<cwd>)]", and `note` in memory, never the user's words. */
export const NOTE_TYPE = 'optchat-note';

export function textContent(content: unknown, images = true): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part: unknown) => {
    if (typeof part !== 'object' || part === null) return '';
    if ('type' in part && part.type === 'text' && 'text' in part && typeof part.text === 'string') return part.text;
    if (images && isImage(part)) return imageRef(part);
    return '';
  }).filter(Boolean).join('\n');
}
/** What the user typed, as Pi's input event (and so the inbox) saw it: no image references, and without the
 * `[Image …]` notes Pi appends after the text when it resizes, converts or omits an attached image. */
export function typedText(content: unknown) {
  const text = textContent(content, false);
  return { text, bare: text.replace(/\n\n\[Image[ :][^\n]*\](?:\n\[Image[ :][^\n]*\])*$/, '') };
}
/** Pi's convertToLlm sends every custom message to the model as a user message. A shown one is part of the chat, so it
 * becomes a user message here too; another extension's starts with "[customType] ", as the recipe marks background work, so
 * the compactor never takes it for the user's words. A hidden one (display false), such as context an extension injects
 * each turn, stays custom: the model still sees it, and memory and the replay leave it out. Reports reach the model and the
 * previous-exchange replay as user messages; memory logs them as `work`. Peer notes carry their own "[note from …]" tag, and
 * memory logs them as `note`. */
export function asUser(message: AgentMessage): AgentMessage {
  if (message.role !== 'custom' || !message.display) return message;
  const { content, customType, timestamp } = message;
  if (customType === REPORT_TYPE || customType === NOTE_TYPE) return { role: 'user', content, timestamp };
  const tag = `[${customType}] `;
  if (typeof content === 'string') return { role: 'user', content: tag + content, timestamp };
  const [first, ...rest] = content;
  if (first?.type === 'text') return { role: 'user', content: [{ ...first, text: tag + first.text }, ...rest], timestamp };
  return { role: 'user', content: [{ type: 'text', text: tag.trimEnd() }, ...content], timestamp };
}
export function logMessage(memory: Memory, message: AgentMessage, receipt?: string) {
  const date = new Date(message.timestamp).toISOString();
  if (message.role === 'user') memory.append(receipt?.startsWith(REPORT_RECEIPT) ? 'work' : 'user', textContent(message.content), date, receipt);
  else if (message.role === 'assistant') {
    for (const block of message.content) {
      if (block.type === 'text' && block.text.trim()) memory.append('talk', block.text, date);
      if (block.type === 'toolCall') memory.append('tool', `${block.name} ${JSON.stringify(block.arguments)}`, date);
    }
    if (message.stopReason === 'error' || message.stopReason === 'aborted')
      memory.append('echo', `Agent ${message.stopReason}: ${message.errorMessage ?? 'No further details'}`, date);
  } else if (message.role === 'toolResult')
    // A zoom's page already names the images it returns.
    memory.append('echo', cap(`${message.toolName}: ${textContent(message.content, message.toolName !== 'zoom')}`), date);
}
export function boundedMessage(message: AgentMessage): AgentMessage {
  if (message.role !== 'toolResult') return message;
  const text = message.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  if (text.length <= CAP) return message;
  return { ...message, content: [{ type: 'text', text: cap(text) }, ...message.content.filter(c => c.type === 'image')] };
}
/** The caller supplies a single settled run, including any steering after text-only replies. */
function completedExchange(history: readonly AgentMessage[]) {
  const last = history.findLastIndex(m => m.role === 'user' || m.role === 'assistant');
  const answer = history[last];
  if (answer?.role !== 'assistant' || answer.stopReason !== 'stop'
    || answer.content.some(block => block.type === 'toolCall')) return [];
  const content = answer.content.flatMap(block => block.type === 'text' ? [{ type: 'text' as const, text: block.text }] : []);
  if (!content.some(block => block.text.trim())) return [];
  const requests: UserMessage[] = [];
  for (const message of history.slice(0, last)) {
    if (message.role === 'user') requests.push({ ...message, content: textContent(message.content) });
  }
  if (!requests.length) return [];
  return [...requests, { ...answer, content }];
}

/** Default limit in bytes of text (16 KB, ~4,000 tokens). Most exchanges are 1-7 KB; a larger one, usually a big paste, is
 * left out entirely and the model falls back to its summaries in the memory view, zooming for the full text if it needs it. */
export const PREVIOUS_EXCHANGE = DEFAULT_SETTINGS.previousExchangeKB * 1000;

/** The latest successful run on this branch, skipping failed and unfinished runs; none if it is over `limit` bytes. */
export function previousExchange(branch: readonly SessionEntry[], limit = PREVIOUS_EXCHANGE) {
  const exchange = latestExchange(branch);
  const bytes = exchange.reduce((sum, message) => sum + Buffer.byteLength(textContent(message.content)), 0);
  return bytes <= limit ? exchange : [];
}

function latestExchange(branch: readonly SessionEntry[]) {
  let end = -1;
  let legacyEnd = branch.length;
  const messages = (entries: readonly SessionEntry[]) => entries.flatMap(entry => entry.type === 'message' ? [asUser(entry.message)] : entry.type === 'custom_message' ? [asUser({ role: 'custom', customType: entry.customType, content: entry.content, display: entry.display, timestamp: Date.parse(entry.timestamp) })] : []);
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== 'custom' || entry.customType !== RUN_BOUNDARY || !record(entry.data)) continue;
    legacyEnd = i;
    if (entry.data.state === 'end') end = i;
    else if (entry.data.state === 'start') {
      if (end >= 0) {
        const exchange = completedExchange(messages(branch.slice(i + 1, end)));
        if (exchange.length) return exchange;
      }
      end = -1;
    }
  }
  // Older sessions have no run markers. Recover a successful exchange best-effort;
  // text-only steering boundaries cannot be reconstructed for those old runs.
  const legacy = messages(branch.slice(0, legacyEnd));
  let boundary = 0;
  let latest: ReturnType<typeof completedExchange> = [];
  for (let i = 0; i < legacy.length; i++) {
    const message = legacy[i];
    if (message.role !== 'assistant' || message.stopReason === 'toolUse') continue;
    const exchange = completedExchange(legacy.slice(boundary, i + 1));
    if (exchange.length) latest = exchange;
    boundary = i + 1;
  }
  return latest;
}

/** Ends every subagent report, so the parent knows it can check the report against what the child did. */
export const fullChat = (id: string) => `Full chat: zoom("${id}")`;
export const withoutFullChat = (text: string) => text.replace(/\n\nFull chat: zoom\("[\w-]+"\)$/gm, '');
const TASK = '\n</chat>\n\nYour task:\n';
/** Tool calls and results in a run transcript keep their head and tail, so a page holds many steps. */
const STEP = 1_000;
/** A subagent's chat for zoom, as `kind|text` lines: its task without the memory view, replies, tool calls and results, and what it was told. */
export function runTranscript(messages: readonly AgentMessage[]) {
  const task = messages.find(message => message.role === 'user');
  return messages.flatMap(message => {
    if (message.role === 'user') {
      // Only the task prompt holds the memory view (src/agents.ts): `${view}\n\nYour task:\n${task}`.
      const text = textContent(message.content, false), at = text.indexOf(TASK);
      return [`user|${message === task && isView(text) && at >= 0 ? text.slice(at + '\n</chat>\n\n'.length) : text}`];
    }
    if (message.role === 'toolResult') return [`echo|${cap(`${message.toolName}: ${textContent(message.content, false)}`, STEP)}`];
    if (message.role !== 'assistant') return [];
    return [...message.content.flatMap(block => block.type === 'text' && block.text.trim() ? [`talk|${block.text}`]
      : block.type === 'toolCall' ? [`tool|${cap(`${block.name} ${JSON.stringify(block.arguments)}`, STEP)}`] : []),
    ...message.stopReason === 'error' || message.stopReason === 'aborted' ? [`echo|Agent ${message.stopReason}: ${message.errorMessage ?? 'No further details'}`] : []];
  }).join('\n');
}

/** The status line naming running agents by id and the first words of their task; none while nothing runs. */
export function atWork(runs: readonly { id: string; task: string }[]) {
  if (!runs.length) return undefined;
  return AT_WORK + runs.map(({ id, task }) => {
    const words = flat(task).replaceAll('"', "'").split(/\s+/).filter(Boolean), start = words.slice(0, 6).join(' ');
    // Six words, but never more than 60 characters: a task can be one long word.
    const preview = [...start].slice(0, 60).join('');
    return `${id} "${preview}${words.length > 6 || preview.length < start.length ? '…' : ''}"`;
  }).join(', ') + '.';
}

/** Keep one completed exchange plus the current run; all other history comes from the view.
 * `status` goes last, after everything cached, so it never moves the cached prefix (see cachePayload). It comes with new input only
 * (the user, a report, a restart note): a call that follows a tool result is the same turn, which already had it. */
export function buildContext(canonical: AgentMessage[], run: AgentMessage[], view: string, prompt: string,
  previous: readonly AgentMessage[] = [], status?: string): AgentMessage[] {
  const system = getCurrentSystemMessage(canonical);
  const head: SystemMessage = { role: 'system', content: prompt, toolsAdded: system?.toolsAdded, timestamp: 0 };
  if (!run.some(m => m.role === 'user')) throw new Error('OptChat has no current user message; refusing to send historical context.');
  let injected = false;
  const messages = [...previous, ...run].filter(m => m.role !== 'system').map(message => {
    if (message.role !== 'user' || injected) return message;
    injected = true;
    // OpenAI joins text blocks with nothing between them, so the user's words start their own paragraph after the view.
    const [first, ...rest] = typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content;
    return { ...message, content: [{ type: 'text' as const, text: view }, ...first?.type === 'text' ? [{ ...first, text: `\n\n${first.text}` }] : first ? [first] : [], ...rest] };
  });
  return [head, ...messages, ...status && messages.at(-1)?.role !== 'toolResult' ? [{ role: 'user' as const, content: [{ type: 'text' as const, text: status }], timestamp: 0 }] : []];
}

/** Pi's own estimate for an image when it decides to compact: 4,800 characters, about 1,200 tokens. */
const IMAGE_CHARS = 4_800;
/** Characters a message adds to a request: its text, thinking, tool-call arguments and images, as Pi estimates them. Framing is left out. */
export function messageChars(message: AgentMessage) {
  if (!('content' in message)) return 0;
  const { content } = message;
  if (typeof content === 'string') return content.length;
  return content.reduce((sum, block) => sum + (block.type === 'text' ? block.text.length : block.type === 'thinking' ? block.thinking.length
    : block.type === 'toolCall' ? JSON.stringify(block.arguments).length : block.type === 'image' ? IMAGE_CHARS : 0), 0);
}
/** The share of the model's window the current turn's verbatim messages may fill before they move into memory (#146): the
 * profile's Turn refresh threshold, unless `OPTCHAT_REFRESH_AT` gives one (0 turns it off). */
export function refreshFraction(setting: number, env = process.env.OPTCHAT_REFRESH_AT) {
  const override = env?.trim() ? Number(env) : NaN;
  return Number.isFinite(override) ? override : setting;
}
/** That share in characters, at ~4 characters a token; none when off or the window is unknown. */
export function refreshBudget(contextWindow: number | undefined, fraction: number) {
  return contextWindow && fraction > 0 ? Math.floor(contextWindow * fraction * 4) : undefined;
}
const chars = (messages: readonly AgentMessage[]) => messages.reduce((sum, m) => sum + messageChars(m), 0);
/** Where a refresh would cut the run: the last model reply, so its tool calls and their results stay whole. 0 when there is none after the task. */
export function lastStep(run: readonly AgentMessage[]) {
  const task = run.findIndex(m => m.role === 'user'), step = run.findLastIndex(m => m.role === 'assistant');
  return step > task && task >= 0 ? step : 0;
}
/** The run's new `keep` and the size it moves into the view, when what is sent since the last refresh passes the budget.
 * What stays verbatim (the task and the last step) must fit in half the budget: a bigger last step, such as many parallel
 * reads, would otherwise pass the budget again on the next call and refresh every call. It waits for a smaller step instead. */
export function refreshPoint(run: readonly AgentMessage[], keep: number, budget: number | undefined) {
  const cut = lastStep(run), task = run.find(m => m.role === 'user');
  if (!budget || cut <= keep) return undefined;
  const size = chars(run.slice(keep));
  if (size <= budget || (task ? messageChars(task) : 0) + chars(run.slice(cut)) > budget / 2) return undefined;
  return { cut, size };
}
/** The run as sent after a mid-turn refresh at `keep`: the task verbatim, then the run from `keep` on. Everything between is in the view. */
export function refreshedRun(run: readonly AgentMessage[], keep: number, note: string): AgentMessage[] {
  const task = run.find(m => m.role === 'user');
  if (!keep || !task) return [...run];
  const content = typeof task.content === 'string' ? [{ type: 'text' as const, text: task.content }] : task.content;
  return [{ ...task, content: [...content, { type: 'text' as const, text: `\n\n${note}` }] }, ...run.slice(keep)];
}
