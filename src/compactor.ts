import { setTimeout as sleep } from 'node:timers/promises';
import { clampThinkingLevel, isRetryableAssistantError, type Api, type AssistantMessage, type Message, type Model } from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import { COMPACT, compaction, IMPORT_GUIDANCE, tooLong } from './prompts.ts';
import { bytes, cut, Refused, type Compressor } from './memory.ts';
import { cachePayload, splitView } from './cache.ts';
import { DEFAULT_SETTINGS } from './settings.ts';

export interface ModelChoice { provider: string; model: string; thinking: ThinkingLevel }
/** A level the model can't take would be sent as no level, which Sonnet 5.5 runs at high effort; Pi's own sessions clamp the same way. */
export const reasoningFor = (model: Model<Api>, level: ThinkingLevel) => {
  const thinking = clampThinkingLevel(model, level);
  return thinking === 'off' ? undefined : thinking;
};
const WARM_MS = 4 * 60_000; // Anthropic's short cache lives 5 minutes from its last use.

/** Parallel calls can't read a cache entry that isn't written yet, so one call primes a cold prefix and the rest wait until it answers.
 * Parallel compactions end their views at different messages, so a call also waits for a primer of a shorter prefix of its own view. */
function primeFirst() {
  const warm = new Map<string, number | Promise<void>>();
  return async (prefix: string, signal: AbortSignal) => {
    const priming = () => { for (const [k, state] of warm) if (typeof state !== 'number' && prefix.startsWith(k)) return state; };
    for (let state = warm.get(prefix) ?? priming(); state !== undefined; state = warm.get(prefix) ?? priming()) {
      if (typeof state === 'number') { if (Date.now() - state < WARM_MS) break; warm.delete(prefix); continue; }
      // A cancelled waiter leaves at once instead of waiting for someone else's primer.
      signal.throwIfAborted();
      let wake = () => {};
      const aborted = new Promise<void>(resolve => { wake = resolve; });
      signal.addEventListener('abort', wake, { once: true });
      await Promise.race([state, aborted]);
      signal.removeEventListener('abort', wake);
      signal.throwIfAborted();
    }
    let release = () => {};
    const pending = warm.has(prefix) ? undefined : new Promise<void>(resolve => { release = resolve; });
    if (pending) warm.set(prefix, pending);
    return (ok: boolean) => {
      if (ok) { for (const [k, at] of warm) if (typeof at === 'number' && Date.now() - at >= WARM_MS) warm.delete(k); warm.set(prefix, Date.now()); }
      else if (warm.get(prefix) === pending) warm.delete(prefix);
      release();
    };
  };
}
/** Pi's agent loop retries a dropped connection itself; streamSimple doesn't, so a transient error is asked again before it surfaces. */
export async function retryTransient(ask: () => Promise<AssistantMessage>, onReply: (reply: AssistantMessage) => void,
  delays: readonly number[] = [1000, 2000], signal?: AbortSignal) {
  for (let retry = 0; ; retry++) {
    const reply = await ask();
    onReply(reply);
    if (retry >= delays.length || !isRetryableAssistantError(reply)) return reply;
    await sleep(delays[retry], undefined, { signal });
  }
}

/** The model is asked for 512 bytes; `accepted` is the longest line kept without a retry (the profile's summary size tolerance). */
export function createCompressor(registry: ModelRegistry, choice: () => ModelChoice,
  onUsage: (message: AssistantMessage) => void = () => {}, accepted = () => DEFAULT_SETTINGS.summaryAcceptBytes,
  retryDelays?: readonly number[]): Compressor {
  const gate = primeFirst();
  return async (input, signal) => {
    const selected = choice();
    const model = registry.find(selected.provider, selected.model);
    if (!model) throw new Error(`Compactor model unavailable: ${selected.provider}/${selected.model}. Use /optchat model.`);
    const thinking = reasoningFor(model, selected.thinking);
    const step = `${input.historical ? IMPORT_GUIDANCE + '\n\n' : ''}${compaction(input)}`;
    // OpenAI joins text blocks with nothing between them, so the task starts its own paragraph after the view.
    const request = (note?: string): Message[] => [{ role: 'user', timestamp: Date.now(),
      content: [{ type: 'text', text: input.context }, { type: 'text', text: `\n\n${step}` }, ...note ? [{ type: 'text' as const, text: `\n\n${note}` }] : []] }];
    let messages = request();
    const view = splitView(input.context);
    const prefix = model.api === 'anthropic-messages' && view.length > 1 ? `${model.provider}/${model.id}/${thinking ?? 'off'}\n${view.slice(0, -1).join('')}` : undefined;
    const tries: string[] = [];
    const ask = async () => {
      const warmed = prefix ? await gate(prefix, signal) : () => {};
      try {
        const stream = registry.streamSimple(model, { systemPrompt: COMPACT, messages }, {
          // A shared session id is the OpenAI prompt-cache key; SSE because over a websocket Codex would chain unrelated parallel calls on one cached connection.
          sessionId: 'optchat-compactor', transport: 'sse',
          reasoning: thinking, signal, cacheRetention: 'short',
          onPayload: payload => model.api === 'anthropic-messages' ? cachePayload(payload, { end: false }) : payload,
        });
        // The cache entry is usable once the model starts answering.
        for await (const event of stream) if (event.type !== 'start') { warmed(event.type !== 'error'); break; }
        return await stream.result();
      } finally { warmed(false); }
    };
    const answer = () => retryTransient(ask, onUsage, retryDelays, signal);
    for (let attempt = 0; attempt < 5; attempt++) {
      const reply = await answer();
      // A stop reason means the model answered: a refusal or a content filter, which asking again repeats.
      // A provider's own 'error' stop (Mistral) is a failure on its side, not an answer: a plain error, tried again later.
      if (reply.stopReason === 'error' && reply.rawStopReason !== undefined && reply.rawStopReason !== 'error' && !isRetryableAssistantError(reply))
        throw new Refused(reply.errorMessage ?? `Compactor stopped: ${reply.rawStopReason}`);
      if (reply.stopReason === 'error' || reply.stopReason === 'aborted') throw new Error(reply.errorMessage ?? `Compactor ${reply.stopReason}`);
      // A reply cut off at the token limit, or one that calls a tool, is no summary: ask again.
      if (reply.stopReason === 'length' || reply.content.some(c => c.type === 'toolCall')) continue;
      // The compactions' view shows each line under its id+n| head, which a line can copy.
      const line = reply.content.filter(c => c.type === 'text').map(c => c.text).join('').trim().replace(/^\d+\+\d+\|\s*/, '');
      if (!line) throw new Refused('Compactor returned no text.');
      tries.push(line);
      // A merge of two short lines can come back nearly as big as both, so a line must also shrink what it replaces.
      if (bytes(line) <= accepted() && bytes(line) < bytes(input.source)) break;
      // As in the recipe, a retry sends the same blocks plus one note on the last line's size and where the limit cuts it,
      // never the earlier replies or their thinking: the request stays the same size, and the model isn't anchored on its own line.
      messages = request(tooLong(bytes(line), cut(line)));
    }
    if (!tries.length) throw new Refused('Compactor returned no whole line in 5 tries.');
    return tries.reduce((a, b) => bytes(a) <= bytes(b) ? a : b);
  };
}
