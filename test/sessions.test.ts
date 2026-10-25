// Several Pi sessions on one profile at once, each a branch of the profile's memory (src/branch.ts), driven through the real
// extension with a fixture model: what each one sees, and when the others' messages reach it.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { Memory } from '../src/memory.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { COMPACT } from '../src/prompts.ts';
import { listBranches } from '../src/branch.ts';
import { textContent } from '../src/transcript.ts';
import { emptyUsage } from '../src/usage.ts';
import { removeDir } from './support.ts';

// Short paths: lock sockets have a ~103-byte limit on macOS.
const root = mkdtempSync('/tmp/oc-sessions-');
const oldHome = process.env.OPTCHAT_HOME;
process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
process.env.OPTCHAT_HOME = join(root, 'home');
after(() => {
  if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
  delete process.env.OPTCHAT_IDLE_MS;
  removeDir(root);
});
let profiles = 0;
function profile() {
  const name = `p${profiles++}`;
  createProfile(name);
  saveConfig(profilePath(name), { ...loadConfig(profilePath(name)), compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' }, subagent: { provider: 'fixture', model: 'fixture', thinking: 'off' } });
  return name;
}

/** A Pi session on `name`, as `pi --optchat-profile <name>` in `cwd` would be. The model answers "OK to: <prompt>"; a compaction gets a short line. */
async function session(name: string, cwd = root) {
  const dir = mkdtempSync(join(root, 's-'));
  const sent: string[] = [], errors: string[] = [], notes: string[] = [];
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  runtime.registerProvider('fixture', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const compaction = context.messages.some(m => m.role === 'system' && m.content === COMPACT);
      const last = context.messages.at(-1), prompt = textContent(last && 'content' in last ? last.content : '');
      if (!compaction) sent.push(context.messages.map(m => 'content' in m ? textContent(m.content) : '').join('\n'));
      const asked = prompt.includes('</chat>') ? prompt.slice(prompt.lastIndexOf('</chat>') + 7).trim() : prompt;
      // "call <tool> <json>; <tool> <json>" makes the model call those tools, then answer with their results.
      const calls = !compaction && /^call /.test(asked) && context.messages.at(-1)?.role === 'user'
        ? asked.slice(5).split('; ').map((c, k) => ({ type: 'toolCall' as const, id: `call-${k}`, name: c.slice(0, c.indexOf(' ')), arguments: JSON.parse(c.slice(c.indexOf(' ') + 1)) as Record<string, unknown> })) : [];
      const results = context.messages.flatMap(m => m.role === 'toolResult' ? [textContent(m.content)] : []);
      const text = compaction ? 'a summary line' : results.length ? `Results: ${results.join(' | ')}` : `OK to: ${asked}`;
      const message: AssistantMessage = { role: 'assistant', content: calls.length ? calls : [{ type: 'text', text }], stopReason: calls.length ? 'toolUse' : 'stop',
        api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage: emptyUsage() };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: calls.length ? 'toolUse' : 'stop', message }); stream.end(); });
      return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd, agentDir: join(dir, 'agent'), settingsManager,
    noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
  await loader.reload();
  const { session } = await createAgentSession({ cwd, modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), resourceLoader: loader, settingsManager,
    sessionManager: SessionManager.create(cwd, join(dir, 'sessions')), tools: ['peers', 'ask_peer', 'note_peer'] });
  session.extensionRunner.setFlagValue('optchat-profile', name);
  const uiContext: ExtensionUIContext = { ...session.extensionRunner.getUIContext(), notify: (message, type) => { (type === 'error' ? errors : notes).push(message); } };
  await session.bindExtensions({ uiContext, mode: 'print', onError: error => { errors.push(error.error); } });
  const ask = async (text: string) => {
    await session.prompt(text);
    await session.agent.waitForIdle();
    const reply = session.state.messages.at(-1);
    return reply?.role === 'assistant' ? textContent(reply.content) : undefined;
  };
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); };
  open.push(close);
  /** The view the model got with the last prompt. */
  const view = () => { const last = sent.at(-1) ?? ''; return last.slice(0, last.indexOf('</chat>')); };
  /** The id of this session's branch, from the footer. */
  const id = () => /branch ([0-9a-f]{6})/.exec(notes.join('\n'))?.[1] ?? '';
  return { ask, close, sent, view, errors, notes, id };
}
/** Every session's close, so a failed test still lets go of its locks and timers. */
const open: (() => Promise<void>)[] = [];
after(async () => { for (const close of open) await close().catch(() => {}); });
const trunkTexts = (name: string) => {
  const main = join(profilePath(name), 'main');
  return readdirSync(main).flatMap(f => readFileSync(join(main, f), 'utf8').split('\n').filter(Boolean)).map(line => (JSON.parse(line) as { text: string }).text);
};
const until = async (what: string, ok: () => boolean, ms = 5000) => {
  for (const end = Date.now() + ms; !ok();) { if (Date.now() > end) throw new Error(`Timed out: ${what}`); await new Promise(r => setTimeout(r, 20)); }
};

test('two sessions on one profile both open and chat; each sees only the trunk and itself until the other merges', async () => {
  const name = profile();
  const a = await session(name, '/tmp'), b = await session(name, root);
  try {
    assert.equal(await a.ask('alpha: rename the auth endpoint'), 'OK to: alpha: rename the auth endpoint');
    assert.equal(await b.ask('beta: build the login page'), 'OK to: beta: build the login page');
    assert.doesNotMatch(b.view(), /alpha/, 'b started before a said anything');
    assert.equal(await a.ask('alpha again'), 'OK to: alpha again');
    assert.match(a.view(), /alpha: rename the auth endpoint/);
    assert.doesNotMatch(a.view(), /beta/, 'a does not see b while both run');
    assert.deepEqual(trunkTexts(name), [], 'nothing reaches the trunk while both are open');
    await a.close();
    assert.deepEqual(trunkTexts(name), ['alpha: rename the auth endpoint', 'OK to: alpha: rename the auth endpoint', 'alpha again', 'OK to: alpha again'], 'a merged when it closed');
    const c = await session(name);
    try {
      await c.ask('gamma');
      assert.match(c.view(), /alpha: rename the auth endpoint/, 'a session started later sees what a said');
      assert.doesNotMatch(c.view(), /beta/, 'and not b, which is still open');
    } finally { await c.close(); }
    await b.close();
    const texts = trunkTexts(name);
    assert.equal(texts.length, 4 + 2 + 1 + 2, 'a, then c, then a note and b');
    assert.match(texts[6], /^Another session's messages follow: branch [0-9a-f]{6}, in \/tmp\/oc-sessions-/, 'b went in after the others, saying where it came from');
    assert.deepEqual(texts.slice(7), ['beta: build the login page', 'OK to: beta: build the login page']);
    assert.ok(listBranches(profilePath(name)).every(info => info.closed), 'every branch closed');
    for (const s of [a, b]) assert.deepEqual(s.errors, []);
  } finally { await a.close(); await b.close(); }
});

test('a session left idle merges, so a session started after that sees it, and closing later adds nothing twice', async () => {
  const name = profile();
  process.env.OPTCHAT_IDLE_MS = '150';
  const a = await session(name);
  try {
    await a.ask('remember: the deploy key is in vault');
    await until('the idle merge', () => trunkTexts(name).length === 2);
    assert.ok(a.notes.some(n => /merged 2 messages into p\d+'s shared memory \(idle\)/.test(n)));
    const b = await session(name);
    try {
      await b.ask('where is the deploy key?');
      assert.match(b.view(), /the deploy key is in vault/);
    } finally { await b.close(); }
    await a.ask('one more thing');
    await a.close();
    assert.deepEqual(trunkTexts(name), ['remember: the deploy key is in vault', 'OK to: remember: the deploy key is in vault', 'where is the deploy key?', 'OK to: where is the deploy key?',
      // b merged first, so a's last two moved after it, with a note.
      trunkTexts(name)[4], 'one more thing', 'OK to: one more thing']);
    assert.match(trunkTexts(name)[4], /^Another session's messages follow/);
  } finally { delete process.env.OPTCHAT_IDLE_MS; await a.close(); }
});

test('a session whose view batch-merges after another session merged starts again from the trunk, and then sees it', { timeout: 60_000 }, async () => {
  const name = profile();
  // A trunk whose view is just under its 128,000-byte budget: about 280 short lines.
  const seed = new Memory(profilePath(name), async () => 'a summary line', () => {});
  for (let k = 0; k < 280; k++) seed.append(k % 2 ? 'talk' : 'user', `seed ${k} ${'x'.repeat(430)}`);
  await seed.settle(AbortSignal.timeout(20_000), 'tree'); await seed.close();
  const a = await session(name), b = await session(name);
  try {
    await b.ask('beta finished the migration');
    await b.close();
    // Each exchange adds two ~460-byte lines to a's view; a batch merge comes within a few of them.
    for (let k = 0; k < 12 && !a.notes.some(n => n.includes('caught up')); k++) await a.ask(`alpha step ${k} ${'y'.repeat(430)}`);
    assert.ok(a.notes.some(n => /caught up with the other sessions on p\d+: this session now starts from message \d+/.test(n)), a.notes.join('\n'));
    await a.ask('alpha after the rebase');
    assert.match(a.view(), /beta finished the migration|a summary line/, 'the view now covers what b said');
    const texts = trunkTexts(name);
    assert.ok(texts.includes('beta finished the migration'));
    assert.ok(texts.some(t => t.startsWith('alpha step 0')), 'a\'s messages before the rebase are in the trunk');
    await a.close();
    const all = trunkTexts(name);
    assert.equal(all.filter(t => t === 'alpha after the rebase').length, 1, 'and its later ones once, after it closed');
    assert.deepEqual(a.errors, []);
  } finally { await a.close(); await b.close(); }
});

test('peers lists the other open sessions; a note reaches the end of the peer\'s next input, once, and only one per turn', async () => {
  const name = profile();
  const a = await session(name, '/tmp'), b = await session(name, root);
  try {
    await b.ask('beta: renaming /auth/refresh to /session/refresh');
    const listed = await a.ask('call peers {}');
    assert.match(listed ?? '', new RegExp(`${b.id()} · ${root} · started .* · idle\\n  \\d+\\+1\\|`));
    assert.match(listed ?? '', /renaming \/auth\/refresh/, 'with its latest lines');
    assert.doesNotMatch(listed ?? '', new RegExp(a.id()), 'not itself');
    const sent = await a.ask(`call note_peer {"id":"${b.id()}","text":"I'm changing the auth client too, ping me before you merge"}; note_peer {"id":"${b.id()}","text":"second"}`);
    assert.match(sent ?? '', /Noted\. .* \| .*already left .* a note this turn/);
    assert.equal(b.sent.length, 1, 'the note started nothing in b');
    await b.ask('next step');
    assert.match(b.sent.at(-1)!, new RegExp(`next step\\n\\n\\[note from ${a.id()} \\(/tmp\\)\\] I'm changing the auth client too, ping me before you merge$`));
    await b.ask('and another');
    assert.ok(b.sent.at(-1)!.endsWith('\nand another'), 'a note arrives once (the previous exchange still shows it)');
    assert.match(b.view(), /note from/, 'and stays in b\'s memory with the input it came with');
    assert.match(await a.ask(`call note_peer {"id":"${a.id()}","text":"hi"}`) ?? '', /is this session/);
    assert.match(await a.ask('call note_peer {"id":"abcdef","text":"hi"}') ?? '', /not open/);
    assert.match(await a.ask(`call note_peer {"id":"${b.id()}","text":"${'x'.repeat(281)}"}`) ?? '', /281 bytes; notes are at most 280/);
    for (const s of [a, b]) assert.deepEqual(s.errors, []);
  } finally { await a.close(); await b.close(); }
});
