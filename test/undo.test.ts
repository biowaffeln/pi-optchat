import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { Memory } from '../src/memory.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { textContent } from '../src/transcript.ts';
import { COMPACT } from '../src/prompts.ts';
import { planUndo } from '../src/undo.ts';
import { emptyUsage } from '../src/usage.ts';
import { sessionLog } from './branches-support.ts';
import { removeDir } from './support.ts';

const silent = () => {};
const until = async (predicate: () => boolean, what: string) => {
  for (let i = 0; i < 500 && !predicate(); i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(predicate(), what);
};

// The fixture model answers "ok", reads `file` on "Read it.", and works until stopped on "Hang.". `sent` keeps the text of
// every chat request, so a test can check what the model saw.
async function start(dir: string, file: string) {
  mkdirSync(dir, { recursive: true });
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  const sent: string[] = [];
  let hanging = false;
  runtime.registerProvider('fixture', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context, options) {
      const last = context.messages.at(-1), text = textContent(last && 'content' in last ? last.content : '');
      const compression = context.messages.some(m => m.role === 'system' && m.content === COMPACT);
      if (!compression) sent.push(context.messages.map(m => 'content' in m ? textContent(m.content) : '').join('\n'));
      const reply: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: compression ? 'Summary.' : 'ok' }],
        timestamp: Date.now(), stopReason: 'stop', api: model.api, provider: model.provider, model: model.id, usage: emptyUsage() };
      if (!compression && last?.role === 'user' && text.endsWith('Read it.')) {
        reply.content = [{ type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: file } }]; reply.stopReason = 'toolUse';
      }
      const hang = !compression && last?.role === 'user' && text.endsWith('Hang.');
      const stream = createAssistantMessageEventStream();
      void (async () => {
        if (hang) {
          hanging = true;
          stream.push({ type: 'start', partial: reply });
          await new Promise<void>(resolve => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
          hanging = false;
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
    resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['zoom', 'date', 'read'] });
  const notes: string[] = [];
  let editor = '';
  await session.bindExtensions({ uiContext: { ...session.extensionRunner.getUIContext(), notify: text => { notes.push(text); },
    setEditorText: text => { editor = text; }, getEditorText: () => editor }, mode: 'tui' });
  return { session, notes, sent, editor: () => editor, clearEditor: () => { editor = ''; }, hanging: () => hanging };
}

async function withProfile(body: (profile: string, dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-undo-'));
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = join(dir, 'home');
  try {
    createProfile('fixture');
    const profile = profilePath('fixture'), fixture = { provider: 'fixture', model: 'fixture', thinking: 'off' as const };
    saveConfig(profile, { ...loadConfig(profile), compactor: fixture, subagent: fixture });
    await body(profile, dir);
  } finally {
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    removeDir(dir);
  }
}

test('/undo takes back the last exchange, puts the message back in the editor, and the next turn never sees it', async () => {
  await withProfile(async (profile, dir) => {
    const s = await start(join(dir, 'pi'), join(dir, 'missing.txt'));
    try {
      await s.session.prompt('First question.');
      await s.session.prompt('Tpyo question.');
      assert.ok(sessionLog(profile).some(e => e.text === 'Tpyo question.'), 'the typo is logged');

      await s.session.prompt('/undo');
      assert.equal(s.editor(), 'Tpyo question.', 'the message goes back into the editor');
      assert.match(s.notes.at(-1)!, /^OptChat took back your last message \(2 lines of the log\)\. It is back in the editor\.$/);
      const log = sessionLog(profile);
      assert.deepEqual(log.map(e => [e.kind, e.text]), [['user', 'First question.'], ['talk', 'ok']], 'the exchange is gone from the log');
      assert.deepEqual(log.map(e => e.i), [0, 1], 'the log stays contiguous');

      s.clearEditor();
      await s.session.prompt('Typo question.');
      const last = s.sent.at(-1)!;
      assert.ok(last.includes('Typo question.') && !last.includes('Tpyo'), 'neither the view nor the previous exchange has the typo');
      assert.ok(last.includes('First question.'));
      assert.deepEqual(sessionLog(profile).map(e => e.text), ['First question.', 'ok', 'Typo question.', 'ok']);

      // Again: the exchange before is still this session's own, so it goes the same way.
      await s.session.prompt('/undo');
      await s.session.prompt('/undo');
      assert.deepEqual(sessionLog(profile), [], 'each /undo takes back one exchange');
      await s.session.prompt('/undo');
      assert.equal(s.notes.at(-1), 'Nothing to undo: this chat has no message of yours yet.');
    } finally { await s.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); s.session.dispose(); }
  });
});

test('/undo warns that tool effects stay, and refuses while the reply is still running', async () => {
  await withProfile(async (profile, dir) => {
    const file = join(dir, 'note.txt');
    writeFileSync(file, 'hello');
    const s = await start(join(dir, 'pi'), file);
    try {
      await s.session.prompt('Read it.');
      assert.ok(sessionLog(profile).some(e => e.kind === 'tool' && e.text.startsWith('read ')));
      await s.session.prompt('/undo');
      assert.match(s.notes.at(-1)!, /It ran read: the log is cleaned, but what those tools changed \(files, commands\) was not undone\.$/);
      assert.deepEqual(sessionLog(profile), []);
      assert.equal(s.editor(), 'Read it.');

      const running = s.session.prompt('Hang.');
      await until(s.hanging, 'the reply is streaming');
      await s.session.prompt('/undo');
      assert.equal(s.notes.at(-1), '/undo works once the reply has stopped. Press Esc to stop it, then run /undo again.');
      await s.session.abort(); await running;
      // Stopped with Esc: the message and the aborted reply go.
      await until(() => s.session.isIdle !== false && !s.hanging(), 'the run settled');
      // Something typed in the editor since is never overwritten: the message comes in the notice instead.
      await s.session.prompt('/undo');
      assert.match(s.notes.at(-1)!, /^OptChat took back your last message \(\d lines? of the log\)\.\nYou wrote:\nHang\.$/);
      assert.equal(s.editor(), 'Read it.');
      assert.deepEqual(sessionLog(profile), []);
    } finally { await s.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); s.session.dispose(); }
  });
});

test('/undo refuses a message already merged into the shared memory', async () => {
  process.env.OPTCHAT_IDLE_MS = '100';
  try {
    await withProfile(async (profile, dir) => {
      const s = await start(join(dir, 'pi'), join(dir, 'missing.txt'));
      try {
        await s.session.prompt('Shared question.');
        await until(() => s.notes.some(n => /merged \d+ messages .*\(idle\)/.test(n)), 'the session merged while idle');
        await s.session.prompt('/undo');
        assert.match(s.notes.at(-1)!, /^Nothing to undo: your last message is already in the profile's shared memory/);
        assert.equal(s.editor(), '');
        assert.deepEqual(sessionLog(profile).map(e => e.text), ['Shared question.', 'ok']);
      } finally { await s.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); s.session.dispose(); }
    });
  } finally { delete process.env.OPTCHAT_IDLE_MS; }
});

test('planUndo refuses a message folded into a summary line, and keeps notes and reports logged after it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-undo-plan-'));
  // A tiny view budget makes the view merge old lines; short messages need no compactor call.
  const memory = new Memory(dir, () => Promise.resolve('Summary.'), silent, 400, 2);
  try {
    memory.append('user', 'Old question.');
    for (let k = 0; k < 20; k++) memory.append('talk', `Reply ${k}.`);
    await memory.settle(undefined, 'tree');
    assert.ok(memory.covering(0)!.l > 0, 'the question sits in a summary line');
    assert.match(String(planUndo(memory, 0)), /already folded into a summary line/);

    memory.append('user', 'New question.');
    memory.append('note', '[note from abc (/work)] hi');
    memory.append('tool', 'bash {"command":"ls"}');
    memory.append('echo', 'bash: ok');
    memory.append('work', '[run1] done');
    memory.append('tool', 'zoom {"id":0}');
    const plan = planUndo(memory, 0);
    assert.ok(typeof plan !== 'string');
    assert.equal(plan.text, 'New question.');
    assert.deepEqual(plan.keep.map(e => e.kind), ['note', 'work'], 'notes and reports stay');
    assert.equal(plan.removed, 4);
    assert.deepEqual(plan.tools, ['bash'], 'memory tools leave nothing to warn about');
    assert.match(String(planUndo(memory, memory.root.length)), /already in the profile's shared memory/);
  } finally { await memory.close(); removeDir(dir); }
});
