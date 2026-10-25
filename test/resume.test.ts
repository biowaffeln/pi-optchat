import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, ModelRegistry, ModelRuntime, type AgentSession } from '@earendil-works/pi-coding-agent';
import { Children } from '../src/agents.ts';
import { Memory } from '../src/memory.ts';
import type { Settings } from '../src/settings.ts';
import { emptyUsage } from '../src/usage.ts';
import { textContent, withoutFullChat } from '../src/transcript.ts';
import { removeDir } from './support.ts';

/** These tests cover delegation below the first level, which profiles opt into with Subagent levels. */
const nested = () => ({ subagentLevels: 3, maxAgents: 8 });

// Children load installed extensions from Pi's agent dir; keep tests away from the user's real one.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'optchat-agent-'));

async function until(condition: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!condition()) { if (Date.now() > deadline) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 10)); }
}

/**
 * A synthetic model whose replies show what the child remembers: its first reply is "<task> first report";
 * later replies quote that first reply, so they prove the earlier conversation is back in context.
 * "resume <id>" makes it call tell on that child. Tasks starting with "hold" or "boss" wait for a release on their first turn.
 */
async function setup(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const releases = new Map<string, () => void>();
  const hooks: { beforeSession?: () => Promise<void>; opened?: (session: AgentSession) => void } = {};
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  runtime.registerProvider('optchat-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'child', name: 'Synthetic child', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const task = textContent(context.messages.find(m => m.role === 'user')?.content).split('Your task:\n').at(-1) ?? '';
      const answers = context.messages.filter(m => m.role === 'assistant');
      const last = context.messages.at(-1), lastText = textContent(last && 'content' in last ? last.content : '');
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: '' }], api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
      if (last?.role === 'user' && lastText.startsWith('resume ')) {
        message.content = [{ type: 'toolCall', id: `call-${answers.length}`, name: 'tell', arguments: { id: lastText.slice(7), message: `${task} wants more` } }];
        message.stopReason = 'toolUse';
      } else message.content = [{ type: 'text', text: last?.role === 'toolResult' ? `asked: ${lastText}`
        : answers.length === 0 ? `${task} first report` : `${task} resumed after "${textContent(answers[0].content)}" heard: ${lastText}` }];
      void (async () => {
        stream.push({ type: 'start', partial: message });
        if (answers.length === 0 && /^(hold|boss)/.test(task)) await new Promise<void>(resolve => {
          releases.set(task, resolve); options?.signal?.addEventListener('abort', () => resolve(), { once: true });
          if (options?.signal?.aborted) resolve();
        });
        if (options?.signal?.aborted) { message.stopReason = 'aborted'; stream.push({ type: 'error', reason: 'aborted', error: message }); }
        else stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message });
        stream.end();
      })();
      return stream;
    },
  });
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const reports: string[] = [], warnings: string[] = [];
  const make = (parentSession: string, settings: () => Partial<Settings> = nested) => new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'child', thinking: 'minimal' }), () => '',
    async text => { reports.push(withoutFullChat(text)); }, text => warnings.push(text), dir, { settings, parentSession, createSession: async options => {
      await hooks.beforeSession?.();
      const created = await createAgentSession({ ...options, modelRuntime: runtime });
      hooks.opened?.(created.session);
      return created;
    } });
  const cleanup = async (...all: Children[]) => {
    for (const release of releases.values()) release();
    for (const children of all) await children.close();
    await memory.close(); removeDir(dir);
  };
  return { dir, releases, hooks, reports, warnings, make, cleanup };
}

const users = (children: Children, id: string) => children.messages(id).filter(m => m.role === 'user').map(m => textContent(m.content));

test('tell resumes a finished child with its earlier conversation, also from an earlier Pi session', async () => {
  const { dir, reports, warnings, make, cleanup } = await setup('optchat-resume-');
  const children = make('first-session');
  let later: Children | undefined;
  try {
    const [id] = await children.spawn([{ task: 'remember' }], dir);
    await until(() => !children.active);
    assert.deepEqual(reports, [`[${id}] remember first report`]);
    const before = structuredClone(children.history.records.get(id)!);

    assert.match(await children.tell(id, 'one more thing'), new RegExp(`^${id} had finished, so I resumed it`));
    const resumed = children.live(id);
    assert.ok(resumed, 'the resumed child is running again and takes a slot');
    assert.ok(children.ids.includes(id));
    assert.equal(children.history.records.get(id)?.state, 'running');
    await until(() => !children.active);
    assert.equal(reports[1], `[${id}] remember resumed after "remember first report" heard: one more thing`);
    const after = children.history.records.get(id)!;
    assert.equal(after.state, 'completed');
    assert.equal(after.report, 'remember resumed after "remember first report" heard: one more thing');
    for (const key of ['id', 'task', 'cwd', 'model', 'depth', 'sessionFile'] as const) assert.equal(after[key], before[key]);
    assert.equal(after.parentId, undefined);
    assert.deepEqual(after.guidance.map(g => [g.text, g.state, g.from]), [['one more thing', 'delivered', 'manager']]);
    assert.equal(users(children, id).length, 2, 'one transcript holds both runs');
    assert.match(readFileSync(after.sessionFile!, 'utf8'), /one more thing/);

    // A new Pi session only has the run record and transcript on disk.
    await children.close();
    later = make('second-session');
    assert.equal(later.history.records.get(id)?.state, 'completed');
    await later.tell(id, 'and once more');
    await until(() => !later!.active);
    assert.equal(reports[2], `[${id}] remember resumed after "remember first report" heard: and once more`);
    assert.equal(later.history.records.get(id)?.parentSession, 'second-session', 'usage of the new turns belongs to the session that resumed it');
    assert.deepEqual(users(later, id).slice(1), ['one more thing', 'and once more']);
    assert.deepEqual(warnings, []);
  } finally { await cleanup(children, ...(later ? [later] : [])); }
});

test('only the parent resumes a nested child, and the resumed child reports to that parent', async () => {
  const { dir, releases, reports, warnings, make, cleanup } = await setup('optchat-resume-nested-');
  const children = make('session');
  try {
    const [boss] = await children.spawn([{ task: 'boss' }], dir);
    await until(() => releases.has('boss'));
    const [worker] = await children.spawn([{ task: 'worker' }], dir, undefined, boss);
    await until(() => children.history.records.get(worker)?.state === 'completed' && !children.live(worker));
    await assert.rejects(children.tell(worker, 'from main'), new RegExp(`Only ${worker}'s parent ${boss} can resume it. Ask ${boss} with tell`));
    releases.get('boss')!();
    await until(() => !children.active);
    assert.deepEqual(reports, [`[${boss}] boss resumed after "boss first report" heard: [${worker}] worker first report`]);
    await assert.rejects(children.tell(worker, 'from main'), /that parent is no longer running\. Resume .* instead, or spawn a new subagent/);

    // The main agent resumes the boss, which resumes its worker with its own tell tool.
    await children.tell(boss, `resume ${worker}`);
    await until(() => !children.active);
    const bossMessages = JSON.stringify(children.messages(boss));
    assert.ok(bossMessages.includes(`${worker} had finished, so I resumed it`), 'the boss saw the resume result');
    assert.equal(reports.length, 2, 'the worker reports to the boss, not the main agent');
    assert.equal(reports[1], `[${boss}] boss resumed after "boss first report" heard: [${worker}] worker resumed after "worker first report" heard: boss wants more`);
    const record = children.history.records.get(worker)!;
    assert.equal(record.parentId, boss);
    assert.equal(record.depth, 2);
    assert.equal(record.state, 'completed');
    assert.deepEqual(warnings, []);
  } finally { await cleanup(children); }
});

test('resuming refuses missing or broken transcripts and a full profile; runs saved by connected windows still load', async () => {
  const { dir, releases, make, cleanup } = await setup('optchat-resume-errors-');
  // Connected-window conversations saved by an older version: one ended with its handoff, one still open when that Pi died.
  mkdirSync(join(dir, 'runs'), { recursive: true });
  const window = { task: 'chat', cwd: dir, model: 'optchat-test/child', thinking: 'minimal', parentSession: 'old', depth: 1, started: 1, guidance: [], connected: true };
  writeFileSync(join(dir, 'runs', 'window1.optchat.json'), JSON.stringify({ ...window, id: 'window1', ended: 2, state: 'completed', handoff: { reason: 'complete', text: 'done', delivered: true } }));
  writeFileSync(join(dir, 'runs', 'window2.optchat.json'), JSON.stringify({ ...window, id: 'window2', state: 'running' }));
  const children = make('session');
  try {
    assert.equal(children.history.records.get('window1')?.state, 'completed', 'the extra connected and handoff fields are ignored');
    const open = children.history.records.get('window2');
    assert.equal(open?.state, 'interrupted', 'an open one is cut off like any active run');
    assert.equal(open?.cutOff, undefined, 'but is not resumed: its window is gone');
    await assert.rejects(children.tell('nobody', 'hello'), /No running subagent nobody/);

    const [gone, broken, full] = await children.spawn([{ task: 'gone' }, { task: 'broken' }, { task: 'full' }], dir);
    await until(() => !children.active);
    await assert.rejects(children.tell(full, '   '), /Message is empty/);
    rmSync(children.history.records.get(gone)!.sessionFile!);
    await assert.rejects(children.tell(gone, 'hello'), /transcript of .* is missing or unreadable.*Spawn a fresh subagent/);
    writeFileSync(children.history.records.get(broken)!.sessionFile!, 'not a session\n');
    await assert.rejects(children.tell(broken, 'hello'), /missing or unreadable/);
    assert.equal(readFileSync(children.history.records.get(broken)!.sessionFile!, 'utf8'), 'not a session\n', 'a refused resume does not touch the transcript');
    assert.equal(children.history.records.get(broken)?.state, 'completed', 'a refused resume leaves the record alone');

    await children.spawn(Array.from({ length: 8 }, (_, i) => ({ task: `hold ${i}` })), dir);
    await until(() => releases.size === 8);
    await assert.rejects(children.tell(full, 'hello'), /at most 8 active agents/);
    assert.equal(children.live(full), undefined);
    assert.equal(children.history.records.get(full)?.state, 'completed');
    for (const release of releases.values()) release();
    await until(() => !children.active);
    await children.tell(full, 'now there is room');
    await until(() => !children.active);
    assert.equal(children.history.records.get(full)?.report, 'full resumed after "full first report" heard: now there is room');
  } finally { await cleanup(children); }
});

test('a child whose parent stops while it is being resumed does not start', async () => {
  const { dir, releases, hooks, make, cleanup } = await setup('optchat-resume-cancel-');
  const children = make('session');
  try {
    // The parent is stopped while its child's session is being opened: the child must not start.
    const [boss] = await children.spawn([{ task: 'boss' }], dir);
    await until(() => releases.has('boss'));
    const [worker] = await children.spawn([{ task: 'worker' }], dir, undefined, boss);
    await until(() => children.history.records.get(worker)?.state === 'completed' && !children.live(worker));
    let opening!: () => void, opened!: () => void;
    const started = new Promise<void>(resolve => { opening = resolve; });
    hooks.beforeSession = () => { opening(); return new Promise<void>(resolve => { opened = resolve; }); };
    let disposed = 0;
    hooks.opened = session => { const dispose = session.dispose.bind(session); session.dispose = () => { disposed++; dispose(); }; };
    const resume = children.tell(worker, 'more', 'manager', boss);
    await started;
    await children.stop(boss);
    hooks.beforeSession = undefined; opened();
    await assert.rejects(resume, /Parent or profile is stopping/);
    await until(() => !children.active);
    assert.equal(children.live(worker), undefined);
    assert.equal(children.history.records.get(worker)?.state, 'completed');
    assert.equal(users(children, worker).length, 1, 'the cancelled child never got the message');
    assert.equal(disposed, 1, 'the opened session is closed');
  } finally { await cleanup(children); }
});

test('a resume being opened holds its slot and refuses a second resume of the same child', async () => {
  const { dir, hooks, reports, make, cleanup } = await setup('optchat-resume-race-');
  const children = make('session');
  let opened = () => {};
  try {
    const [solo] = await children.spawn([{ task: 'solo' }], dir);
    await until(() => !children.active);
    let opening!: () => void;
    const started = new Promise<void>(resolve => { opening = resolve; });
    hooks.beforeSession = () => { hooks.beforeSession = undefined; opening(); return new Promise<void>(resolve => { opened = resolve; }); };
    const resume = children.tell(solo, 'more');
    await started;
    await assert.rejects(children.tell(solo, 'again'), /still finishing/, 'a second resume waits for the first');
    await assert.rejects(children.spawn(Array.from({ length: 8 }, (_, i) => ({ task: `extra ${i}` })), dir), /at most 8 active agents/, 'the opening resume holds a slot');
    opened();
    assert.match(await resume, /had finished, so I resumed it/);
    await until(() => !children.active);
    assert.equal(reports.at(-1), `[${solo}] solo resumed after "solo first report" heard: more`);
  } finally { opened(); await cleanup(children); }
});

test('a resume whose record cannot be saved leaves the child finished and resumable', async () => {
  const { dir, hooks, reports, make, cleanup } = await setup('optchat-resume-save-');
  const children = make('session');
  try {
    // Saving the resumed record fails: nothing changes, the session is closed, and a later resume works.
    const [solo] = await children.spawn([{ task: 'solo' }], dir);
    await until(() => !children.active);
    const save = children.history.save.bind(children.history);
    children.history.save = () => { throw new Error('disk full'); };
    let disposed = 0;
    hooks.opened = session => { const dispose = session.dispose.bind(session); session.dispose = () => { disposed++; dispose(); }; };
    await assert.rejects(children.tell(solo, 'more'), /disk full/);
    children.history.save = save; hooks.opened = undefined;
    assert.equal(disposed, 1, 'the opened session is closed');
    assert.equal(children.live(solo), undefined);
    const record = children.history.records.get(solo)!;
    assert.equal(record.state, 'completed');
    assert.equal(typeof record.ended, 'number');
    assert.deepEqual(record.guidance, []);
    assert.equal(children.active, false, 'the slot is free again');
    await children.tell(solo, 'after recovery');
    await until(() => !children.active);
    assert.equal(reports.at(-1), `[${solo}] solo resumed after "solo first report" heard: after recovery`);
  } finally { await cleanup(children); }
});

test('a stop that arrives while a finished child shuts down leaves it completed', async () => {
  const { dir, hooks, make, cleanup } = await setup('optchat-late-stop-');
  const children = make('session');
  let finish!: () => void;
  const finishing = new Promise<void>(resolve => { finish = resolve; });
  try {
    hooks.opened = session => { const emit = session.extensionRunner.emit.bind(session.extensionRunner);
      session.extensionRunner.emit = (async (event: Parameters<typeof emit>[0]) => { if (event.type === 'session_shutdown') await finishing; return emit(event); }) as typeof emit; };
    const [id] = await children.spawn([{ task: 'quick' }], dir);
    await until(() => children.history.records.get(id)?.state === 'completed' && !!children.live(id));
    await children.stop(id);
    finish();
    await until(() => !children.active);
    assert.equal(children.history.records.get(id)?.state, 'completed', 'a finished run never moves to stopping again');
  } finally { finish(); await cleanup(children); }
});

for (const [name, launch] of [['resume', (children: Children, id: string, dir: string) => children.tell(id, 'more')],
  ['spawn', (children: Children, _id: string, dir: string) => children.spawn([{ task: 'late' }], dir)]] as const) {
  test(`close() waits for a ${name} that is still opening its session`, async () => {
    const { dir, hooks, make, cleanup } = await setup(`optchat-close-${name}-`);
    const children = make('session');
    try {
      const [id] = await children.spawn([{ task: 'solo' }], dir);
      await until(() => !children.active);
      let opening!: () => void, opened!: () => void, disposed = 0;
      const started = new Promise<void>(resolve => { opening = resolve; });
      hooks.beforeSession = () => { opening(); return new Promise<void>(resolve => { opened = resolve; }); };
      hooks.opened = session => { const dispose = session.dispose.bind(session); session.dispose = () => { disposed++; dispose(); }; };
      const refused = assert.rejects(launch(children, id, dir), /Parent or profile is stopping|Profile is closing/);
      await started;
      const closing = children.close();
      hooks.beforeSession = undefined; opened();
      await closing;
      assert.equal(disposed, 1, 'close() returned while a session was still being created');
      await refused;
    } finally { await cleanup(children); }
  });
}

test('a tell that loses the race with the child finishing is refused, not reported as queued', async () => {
  const { dir, hooks, releases, make, cleanup } = await setup('optchat-tell-race-');
  const children = make('session');
  try {
    let open!: () => void;
    const steering = new Promise<void>(resolve => { open = resolve; });
    hooks.opened = session => { const steer = session.steer.bind(session); session.steer = async text => { await steering; return steer(text); }; };
    const [id] = await children.spawn([{ task: 'hold a' }], dir);
    await until(() => releases.has('hold a'));
    const refused = assert.rejects(children.tell(id, 'please do X'), /finished before it read the message/);
    releases.get('hold a')!();
    await until(() => children.history.records.get(id)?.state === 'completed');
    open();
    await refused;
    assert.equal(children.history.records.get(id)?.guidance[0].state, 'undelivered');
  } finally { await cleanup(children); }
});

test('subagents cut off by Pi closing or crashing are resumed at the next start, and the main agent is told once', async () => {
  const { dir, releases, reports, warnings, make, cleanup } = await setup('optchat-resume-restart-');
  const first = make('first-session');
  const later: Children[] = [];
  try {
    const [held] = await first.spawn([{ task: 'hold on' }], dir);
    const [crashed] = await first.spawn([{ task: 'crashed' }], dir);
    await until(() => releases.has('hold on') && first.history.records.get(crashed)?.state === 'completed' && !first.live(crashed));
    // As if Pi had died while this one was still working.
    first.history.save({ ...first.history.records.get(crashed)!, state: 'running', ended: undefined });
    reports.length = 0;
    await first.close();
    assert.equal(reports.length, 0, 'a run Pi cut off does not report its abort');
    assert.equal(first.history.records.get(held)?.state, 'interrupted');

    later.push(make('second-session'));
    await later[0].resumeCutOff();
    assert.equal(reports[0], `Pi restarted while subagents were working. Resumed ${held}, ${crashed} from where they left off; reports arrive as usual.`);
    await until(() => !later[0].active);
    for (const id of [held, crashed]) {
      assert.match(users(later[0], id).at(-1) ?? '', /^Pi restarted while you were working\. Your last tool call may have been cut off; check its effect before redoing it\. Continue your task\.$/);
      assert.equal(later[0].history.records.get(id)?.state, 'completed');
      assert.ok(reports.some(r => r.startsWith(`[${id}] `)), 'the resumed run reports as usual');
    }
    const told = reports.length;
    later.push(make('third-session'));
    await later[1].resumeCutOff();
    assert.equal(reports.length, told, 'nothing left to resume, nothing to say');
    assert.deepEqual(warnings, []);
  } finally { await cleanup(first, ...later); }
});

test('with grouped reports, the main agent is told that resumed subagents now report on their own', async () => {
  const { dir, releases, reports, make, cleanup } = await setup('optchat-resume-restart-group-');
  const grouped = () => ({ ...nested(), groupReports: true });
  const first = make('first-session', grouped);
  let later: Children | undefined;
  try {
    const [held, done] = /^Started: (.+?)\./.exec(await first.start([{ task: 'hold on' }, { task: 'done' }], dir))![1].split(', ');
    await until(() => releases.has('hold on') && first.history.records.get(done)?.state === 'completed');
    await first.close();
    assert.deepEqual(reports, [], 'the finished report was held for its sibling');

    later = make('second-session', grouped);
    await later.resumeCutOff();
    assert.equal(reports[0], `Pi restarted while subagents were working. Resumed ${held} from where it left off; grouped reports do not survive a restart, so each one reports on its own.`);
    await until(() => !later!.active);
    assert.match(reports[1], new RegExp(`^\\[${held}\\] `), 'the resumed run reports alone');
  } finally { await cleanup(first, ...(later ? [later] : [])); }
});

test('runs stopped or paused by the user, finished runs and older interrupted ones are not resumed at the next start', async () => {
  const { dir, releases, reports, make, cleanup } = await setup('optchat-resume-restart-skip-');
  const first = make('first-session');
  let later: Children | undefined;
  try {
    const [stopped, paused, done, old] = await first.spawn([{ task: 'hold stop' }, { task: 'hold pause' }, { task: 'done' }, { task: 'old' }], dir);
    await until(() => releases.has('hold stop') && releases.has('hold pause') && !first.live(done) && !first.live(old));
    await first.stop(stopped);
    assert.equal(await first.interrupt(paused), 'paused');
    await until(() => first.history.records.get(stopped)?.state === 'stopped' && first.history.records.get(paused)?.state === 'paused');
    // Interrupted before Pi resumed cut-off runs.
    first.history.save({ ...first.history.records.get(old)!, state: 'interrupted' });
    await first.close();
    const before = reports.length;

    later = make('second-session');
    await later.resumeCutOff();
    assert.equal(reports.length, before);
    assert.deepEqual(later.ids, []);
    assert.deepEqual([stopped, paused, done, old].map(id => later!.history.records.get(id)?.state), ['stopped', 'stopped', 'completed', 'interrupted']);
  } finally { await cleanup(first, ...(later ? [later] : [])); }
});

test('a cut-off child is named to its resumed parent, or to the main agent when its parent was not cut off', async () => {
  const { dir, releases, reports, make, cleanup } = await setup('optchat-resume-restart-nested-');
  const first = make('first-session');
  let later: Children | undefined;
  try {
    const [boss, idle] = await first.spawn([{ task: 'boss' }, { task: 'boss idle' }], dir);
    await until(() => releases.has('boss') && releases.has('boss idle'));
    const [worker] = await first.spawn([{ task: 'hold worker' }], dir, undefined, boss);
    const [stray] = await first.spawn([{ task: 'hold stray' }], dir, undefined, idle);
    await until(() => releases.has('hold worker') && releases.has('hold stray'));
    assert.equal(await first.interrupt(idle), 'paused'); // Waiting for the user: not resumed, but its working child was cut off.
    await until(() => first.history.records.get(idle)?.state === 'paused');
    reports.length = 0;
    await first.close();

    later = make('second-session');
    await later.resumeCutOff();
    assert.equal(reports[0], `Pi restarted while subagents were working. Resumed ${boss} from where it left off; reports arrive as usual.\nAlso cut off, but not resumed because their parent agent is not running: ${stray} (under ${idle}).`);
    await until(() => !later!.active);
    assert.match(users(later, boss).at(-1) ?? '', new RegExp(`Your subagents ${worker} were cut off by a Pi restart: tell resumes one`));
    assert.deepEqual([worker, stray].map(id => later!.history.records.get(id)?.cutOff), [undefined, undefined], 'each was named once');
    assert.deepEqual(later.ids, []);
  } finally { await cleanup(first, ...(later ? [later] : [])); }
});

test('a cut-off run the main agent resumes itself during startup is left alone', async () => {
  const { dir, releases, reports, hooks, make, cleanup } = await setup('optchat-resume-restart-race-');
  const first = make('first-session');
  let later: Children | undefined;
  try {
    const [slow, told] = await first.spawn([{ task: 'hold slow' }, { task: 'hold told' }], dir);
    await until(() => releases.has('hold slow') && releases.has('hold told'));
    await first.close();
    reports.length = 0;

    later = make('second-session');
    // The first resume stalls while it opens; meanwhile the main agent tells the other one, which resumes it.
    let opening!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { opening = resolve; });
    hooks.beforeSession = () => { hooks.beforeSession = undefined; opening(); return new Promise<void>(resolve => { release = resolve; }); };
    const resuming = later.resumeCutOff();
    await started;
    await later.tell(told, 'from main');
    const stale: string[] = [];
    const save = later.history.save.bind(later.history);
    later.history.save = run => { if (run.id === told) stale.push(run.state); save(run); };
    release();
    await resuming;
    assert.ok(!stale.includes('interrupted'), 'the live record is not overwritten by the one read at startup');
    assert.equal(reports[0], `Pi restarted while subagents were working. Resumed ${slow} from where it left off; reports arrive as usual.`);
    await until(() => !later!.active);
    assert.equal(users(later, told).at(-1), 'from main');
    assert.equal(later.history.records.get(told)?.state, 'completed');
  } finally { await cleanup(first, ...(later ? [later] : [])); }
});
