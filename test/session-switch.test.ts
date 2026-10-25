import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import { TuiMainScreen, type Terminal } from '@earendil-works/pi-tui';
import optchat from '../src/index.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { textContent } from '../src/transcript.ts';
import { COMPACT } from '../src/prompts.ts';
import { emptyUsage } from '../src/usage.ts';
import { removeDir } from './support.ts';

class OffscreenTerminal implements Terminal {
  start() {} stop() {} async drainInput() {} write(_data: string) {}
  get columns() { return 100; } get rows() { return 30; } get kittyProtocolActive() { return false; }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {}
}
const until = async (predicate: () => boolean, what: string) => {
  for (let i = 0; i < 500 && !predicate(); i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(predicate(), what);
};

// Main spawns one child on "Spawn one."; the child works until it is stopped.
async function start(dir: string, ui: Partial<ExtensionUIContext>) {
  mkdirSync(dir, { recursive: true });
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  runtime.registerProvider('fixture', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context, options) {
      const last = context.messages.at(-1), text = textContent(last && 'content' in last ? last.content : '');
      const compression = context.messages.some(m => m.role === 'system' && m.content === COMPACT), child = text.includes('\n\nYour task:\n');
      const reply: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: compression ? 'Summary.' : 'ok' }],
        timestamp: Date.now(), stopReason: 'stop', api: model.api, provider: model.provider, model: model.id, usage: emptyUsage() };
      if (!compression && !child && text.endsWith('Spawn one.')) {
        reply.content = [{ type: 'toolCall', id: 'spawn-1', name: 'spawn', arguments: { tasks: [{ task: 'Work until stopped.' }] } }]; reply.stopReason = 'toolUse';
      }
      const stream = createAssistantMessageEventStream();
      void (async () => {
        if (child) {
          stream.push({ type: 'start', partial: reply });
          await new Promise<void>(resolve => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
        }
        if (options?.signal?.aborted) { reply.stopReason = 'aborted'; stream.push({ type: 'error', reason: 'aborted', error: reply }); }
        else stream.push({ type: 'done', reason: reply.stopReason === 'toolUse' ? 'toolUse' : 'stop', message: reply });
        stream.end();
      })();
      return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager,
    noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
  await loader.reload();
  const manager = SessionManager.create(dir, join(dir, 'sessions'));
  manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
  const { session } = await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'),
    resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['zoom', 'date', 'spawn'] });
  const notes: string[] = [];
  await session.bindExtensions({ uiContext: { ...session.extensionRunner.getUIContext(), notify: text => { notes.push(text); }, ...ui }, mode: 'tui' });
  const blocked = async (event: { type: 'session_before_switch'; reason: 'new' | 'resume' } | { type: 'session_before_fork'; entryId: string; position: 'before' | 'at' }) => {
    const before = notes.length, result = await session.extensionRunner.emit(event);
    return { cancel: result?.cancel === true, notes: notes.slice(before) };
  };
  return { session, blocked };
}

test('a blocked /new, /resume, /fork or /clone says why and what lets it through', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-switch-'));
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = join(dir, 'home');
  const sessions: Awaited<ReturnType<typeof start>>['session'][] = [];
  try {
    createProfile('fixture');
    const profile = profilePath('fixture'), fixture = { provider: 'fixture', model: 'fixture', thinking: 'off' as const };
    saveConfig(profile, { ...loadConfig(profile), compactor: fixture, subagent: fixture });
    let pick = (_choice: string | undefined) => {}, picking = false;
    let agent = '', keys: string[] = [], onPage = false;
    // `/optchat agents`: the Agents page opens `agent`, whose view takes `keys` and closes on Esc.
    const custom = (async (factory: Parameters<ExtensionUIContext['custom']>[0]) => {
      if ((onPage = !onPage)) return { open: agent };
      const pressed = [...keys, '\x1b'];
      return new Promise<unknown>(resolve => {
        const view = factory(new TuiMainScreen(new OffscreenTerminal()), { fg: (_tone: string, text: string) => text } as never, { matches: () => false } as never, resolve);
        void Promise.resolve(view).then(v => { for (const key of pressed) v.handleInput?.(key); });
      });
    }) as ExtensionUIContext['custom'];
    const agents = async (pressed: string[]) => {
      keys = pressed;
      await owner.session.prompt('/optchat agents');
    };
    const owner = await start(join(dir, 'owner'), { custom, select: async (_title, _options, opts) => {
      picking = true;
      return new Promise<string | undefined>(resolve => { pick = resolve; opts?.signal?.addEventListener('abort', () => resolve(undefined), { once: true }); });
    } });
    sessions.push(owner.session);

    assert.deepEqual(await owner.blocked({ type: 'session_before_switch', reason: 'new' }), { cancel: false, notes: [] }, 'nothing to protect: /new goes through');

    const importing = owner.session.prompt('/optchat import');
    await until(() => picking, 'the import dialog is open');
    const duringImport = await owner.blocked({ type: 'session_before_switch', reason: 'new' });
    assert.equal(duringImport.cancel, true);
    assert.equal(duringImport.notes.length, 1);
    assert.match(duringImport.notes[0], /^\/new is blocked while an import is open\. /);
    pick(undefined); await importing;

    await owner.session.prompt('Spawn one.');
    for (const [event, command] of [
      [{ type: 'session_before_switch', reason: 'new' }, '/new'],
      [{ type: 'session_before_switch', reason: 'resume' }, '/resume'],
      [{ type: 'session_before_fork', entryId: 'x', position: 'before' }, '/fork'],
      [{ type: 'session_before_fork', entryId: 'x', position: 'at' }, '/clone'],
    ] as const) {
      const result = await owner.blocked(event);
      assert.equal(result.cancel, true, `${command} is blocked while an agent works`);
      assert.equal(result.notes.length, 1, `${command} says why`);
      assert.match(result.notes[0], new RegExp(`^${command} is blocked while 1 agent is active: [0-9a-f]{8} \\(working\\)\\. `));
      assert.match(result.notes[0], /Wait for it to finish, or open it in \/optchat agents and press Ctrl\+X twice\.$/);
    }

    agent = /[0-9a-f]{8}/.exec((await owner.blocked({ type: 'session_before_switch', reason: 'new' })).notes[0])![0];
    const newSession = { type: 'session_before_switch', reason: 'new' } as const;
    const waitFor = async (done: (note: string | undefined) => boolean) => {
      let note: string | undefined;
      for (let i = 0; i < 200; i++) {
        note = (await owner.blocked(newSession)).notes[0];
        if (done(note)) break;
        await new Promise(r => setTimeout(r, 10));
      }
      return note;
    };
    await agents(['\x03']);
    assert.equal(await waitFor(note => !!note?.includes('interrupted')),
      `/new is blocked while 1 agent is active: ${agent} (interrupted, waiting for you). Open it in /optchat agents and message it to resume, or press Ctrl+X twice to stop.`,
      'a paused agent the user forgot is named, with how to resume or stop it');

    await agents(['\x18', '\x18']);
    assert.equal(await waitFor(note => note === undefined), undefined, 'once the agent has stopped, /new goes through again');
    assert.deepEqual(await owner.blocked(newSession), { cancel: false, notes: [] });
  } finally {
    for (const session of sessions.reverse()) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    removeDir(dir);
  }
});
