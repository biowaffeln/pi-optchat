import { accessSync, constants, existsSync, realpathSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBashToolDefinition, createLocalBashOperations, type BashOperations } from '@earendil-works/pi-coding-agent';

/** Pi's tools a read-only child keeps; OptChat's own tools (zoom, spawn, tell_parent, ...) are added to these by name. */
export const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls', 'bash'] as const;

/**
 * macOS Seatbelt profile for a read-only child's bash: everything is allowed except writing files, which is allowed again only
 * in the temp directories (TMPDIR lives under /private/var/folders) and /dev, so /dev/null and the terminal still work. Apple
 * events are denied too, so osascript can't ask another app (Finder, Terminal) to write or run something outside the sandbox.
 */
export const SEATBELT_PROFILE = `(version 1)
(allow default)
(deny file-write*)
(deny appleevent-send)
(allow file-write*
  (subpath "/tmp")
  (subpath "/private/tmp")
  (subpath "/private/var/folders")
  (subpath "/dev"))`;

/** How a read-only child's bash commands are confined: `argv` is what runs one command, as separate arguments. */
export interface Sandbox { kind: 'sandbox-exec' | 'bwrap'; argv: (shell: string, command: string) => string[] }

const executable = (path: string) => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } };
const onPath = (name: string, path = process.env.PATH ?? '') => path.split(delimiter).filter(Boolean).map(dir => join(dir, name)).find(executable);
const real = (path: string) => { try { return realpathSync(path); } catch { return path; } };

/** bwrap arguments: the whole filesystem read-only, a fresh /dev, and the temp directories writable. The network is shared. */
export function bwrapArgs(temp = tmpdir()) {
  const writable = [...new Set(['/tmp', real(temp)])].filter(dir => existsSync(dir));
  return ['--ro-bind', '/', '/', '--dev', '/dev', ...writable.flatMap(dir => ['--bind', dir, dir]), '--die-with-parent'];
}

/** The write-denying sandbox this machine offers, or undefined when there is none and bash must be left out. */
export function findSandbox(platform = process.platform, path = process.env.PATH, temp = tmpdir()): Sandbox | undefined {
  if (platform === 'darwin' && executable('/usr/bin/sandbox-exec'))
    return { kind: 'sandbox-exec', argv: (shell, command) => ['/usr/bin/sandbox-exec', '-p', SEATBELT_PROFILE, shell, '-c', command] };
  const bwrap = platform === 'linux' ? onPath('bwrap', path) : undefined;
  if (bwrap) { const args = bwrapArgs(temp); return { kind: 'bwrap', argv: (shell, command) => [bwrap, ...args, '--', shell, '-c', command] }; }
  return undefined;
}

const ARG = 'OPTCHAT_SANDBOX_ARG_';
/**
 * A POSIX sh script that runs `argv` exactly, and the environment that carries it. Each argument travels in its own variable
 * and is expanded once, quoted, so nothing in the command is ever parsed by this outer shell; the variables are unset before
 * the sandbox starts, so the command does not see them.
 */
export function argvScript(argv: string[]) {
  const names = argv.map((_, i) => `${ARG}${i}`);
  const script = `set -- ${names.map(name => `"$${name}"`).join(' ')}; unset ${names.join(' ')}; exec "$@"`;
  return { script, env: Object.fromEntries(argv.map((arg, i) => [names[i], arg])) };
}

/**
 * Bash operations that run every command inside `sandbox`. Pi's own local execution (timeouts, killing the process tree on
 * abort, output streaming) starts a fixed /bin/sh script that execs the sandbox, which runs `shell -c <command>`.
 */
export function sandboxedOperations(sandbox: Sandbox, shell = '/bin/bash', local: BashOperations = createLocalBashOperations({ shellPath: '/bin/sh' })): BashOperations {
  return {
    exec: (command, cwd, options) => {
      const { script, env } = argvScript(sandbox.argv(shell, command));
      return local.exec(script, cwd, { ...options, env: { ...(options.env ?? process.env), ...env } });
    },
  };
}

/** Pi's bash tool with its commands run in `sandbox`; the settings' shell and command prefix still apply, inside it. */
export const sandboxedBashTool = (cwd: string, sandbox: Sandbox, settings: { shellPath?: string; commandPrefix?: string }) =>
  createBashToolDefinition(cwd, { commandPrefix: settings.commandPrefix, operations: sandboxedOperations(sandbox, settings.shellPath || '/bin/bash') });
