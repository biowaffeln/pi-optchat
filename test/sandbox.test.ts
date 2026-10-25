import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BashOperations } from '@earendil-works/pi-coding-agent';
import { argvScript, bwrapArgs, findSandbox, SEATBELT_PROFILE, sandboxedOperations, type Sandbox } from '../src/sandbox.ts';
import { removeDir } from './support.ts';

const NASTY = `echo 'single' "double $HOME" \`backtick\` $(sub) \\ ; rm -rf / # not run\nline two\t%s`;

test('argvScript hands every argument through untouched and keeps them out of the command\'s environment', () => {
  const argv = ['/bin/sh', '-c', 'printf "%s|" "$@"; env | grep -c OPTCHAT_SANDBOX_ARG_ || true', 'sh', NASTY, '', 'a b'];
  const { script, env } = argvScript(argv);
  assert.doesNotMatch(script, /single|backtick|printf/, 'no argument is pasted into the script');
  const out = execFileSync('/bin/sh', ['-c', script], { env: { ...process.env, ...env }, encoding: 'utf8' });
  assert.equal(out, `${NASTY}||a b|0\n`);
});

test('sandboxedOperations runs the sandbox argv, not the command, through Pi\'s local shell', async () => {
  const calls: { command: string; env?: NodeJS.ProcessEnv }[] = [];
  const local: BashOperations = { exec: async (command, _cwd, options) => { calls.push({ command, env: options.env }); return { exitCode: 0 }; } };
  const sandbox: Sandbox = { kind: 'bwrap', argv: (shell, command) => ['/fake/sandbox', '--', shell, '-c', command] };
  await sandboxedOperations(sandbox, '/bin/zsh', local).exec(NASTY, '/', { onData: () => {}, env: { KEEP: '1' } });
  const [{ command, env }] = calls;
  assert.ok(!command.includes('single'));
  assert.equal(env?.KEEP, '1', 'the tool\'s environment is kept');
  assert.deepEqual(Object.keys(env!).filter(k => k.startsWith('OPTCHAT_SANDBOX_ARG_')).sort().map(k => env![k]), ['/fake/sandbox', '--', '/bin/zsh', '-c', NASTY]);
});

test('findSandbox: sandbox-exec on macOS, bwrap on Linux when on PATH, otherwise none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-bwrap-'));
  try {
    if (existsSync('/usr/bin/sandbox-exec')) {
      const mac = findSandbox('darwin', '')!;
      assert.equal(mac.kind, 'sandbox-exec');
      assert.deepEqual(mac.argv('/bin/bash', NASTY), ['/usr/bin/sandbox-exec', '-p', SEATBELT_PROFILE, '/bin/bash', '-c', NASTY]);
      assert.match(SEATBELT_PROFILE, /^\(deny appleevent-send\)$/m, 'osascript can\'t script other apps from inside');
    }
    assert.equal(findSandbox('linux', dir), undefined, 'no bwrap, no sandbox');
    assert.equal(findSandbox('win32', dir), undefined);
    const bwrap = join(dir, 'bwrap');
    writeFileSync(bwrap, '#!/bin/sh\n'); chmodSync(bwrap, 0o755);
    const linux = findSandbox('linux', `/nonexistent:${dir}`, '/tmp')!;
    assert.equal(linux.kind, 'bwrap');
    const argv = linux.argv('/bin/bash', NASTY);
    assert.equal(argv[0], bwrap);
    assert.deepEqual(argv.slice(1, 7), ['--ro-bind', '/', '/', '--dev', '/dev', '--bind']);
    assert.deepEqual(argv.slice(-4), ['--', '/bin/bash', '-c', NASTY]);
    assert.ok(!argv.includes('--unshare-net'), 'the network stays');
    const binds = bwrapArgs(dir).join(' ');
    assert.ok(binds.includes('--bind /tmp /tmp') && binds.includes(`--bind ${realpathSync(dir)} ${realpathSync(dir)}`), `tmp and TMPDIR are writable: ${binds}`);
  } finally { removeDir(dir); }
});

test('on macOS a sandboxed command can read and use git but writes only to temp directories', { skip: process.platform !== 'darwin' && 'macOS only' }, async () => {
  const ops = sandboxedOperations(findSandbox()!), repo = process.cwd();
  const run = async (command: string) => {
    let output = '';
    const { exitCode } = await ops.exec(command, repo, { onData: data => { output += data; }, env: process.env });
    return { exitCode, output };
  };
  const probe = join(repo, `.sandbox-probe-${randomUUID()}`), scratch = join(tmpdir(), `optchat-sandbox-${randomUUID()}`);
  try {
    const denied = await run(`touch '${probe}'`);
    assert.notEqual(denied.exitCode, 0);
    assert.match(denied.output, /Operation not permitted/);
    assert.ok(!existsSync(probe), 'nothing was written in the repository');
    assert.equal((await run(`echo hi > "$TMPDIR/${randomUUID()}" && touch '${scratch}' && echo ok > /dev/null`)).exitCode, 0, 'temp dirs and /dev stay writable');
    assert.ok(existsSync(scratch));
    const log = await run(`git -C '${repo}' log -1 --format=%H`);
    assert.equal(log.exitCode, 0); assert.match(log.output, /^[0-9a-f]{40}\s*$/);
    // git status may try to refresh the index; when that write is refused it carries on and still exits 0.
    assert.equal((await run('git status --porcelain')).exitCode, 0);
  } finally { rmSync(probe, { force: true }); rmSync(scratch, { force: true }); }
});
