import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, realpathSync, statSync, unlinkSync, type Stats } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// Locks are sockets, as the old profile lock was: the OS closes a socket when its process dies, so a lock never outlives a
// crash, and whoever holds one can say who they are. Node has no flock, and a lock file with a PID in it can't tell a dead
// owner from a reused PID. On Windows a socket path becomes a named pipe named after a hash of the directory.

const isWindows = process.platform === 'win32';
// sun_path is 104 bytes on macOS and 108 elsewhere, both including the NUL; a Windows pipe path is capped at 259 characters.
const LIMIT = process.platform === 'darwin' ? 103 : isWindows ? 259 : 107;

/** Where the lock `name` for `dir` listens: `<dir>/<name>.sock`, or a named pipe on Windows. */
export function lockPath(dir: string, name: string) {
  if (!isWindows) return join(dir, `${name}.sock`);
  let identity = resolve(dir);
  // A directory that doesn't exist yet has no real path: its resolved path names it as well.
  try { identity = realpathSync.native(identity); } catch { identity = resolve(dir); }
  return `\\\\.\\pipe\\optchat-${createHash('sha256').update(identity.toLowerCase()).digest('hex').slice(0, 16)}-${name}`;
}

export class LockBusy extends Error {
  constructor(readonly owner: string) { super(`Busy: ${owner}`); }
}

/** A socket that may be replaced; a file that only shares its name is refused, never deleted. */
function existing(path: string): Stats | 'pipe' | undefined {
  if (isWindows) return 'pipe';
  let stat; try { stat = lstatSync(path); } catch { return undefined; }
  if (!stat.isSocket()) throw new Error(`${path} is not an OptChat socket. Move it away and try again.`);
  return stat;
}

/** Who holds the lock at `path`, as they describe themselves; undefined when nobody does. A holder too busy to answer within
 * `timeout` still counts as holding it, described as such. */
export function holder(path: string, timeout = 1500) {
  return new Promise<string | undefined>(done => {
    const socket = createConnection(path); let message = '';
    socket.setTimeout(timeout, () => { socket.destroy(); done('a process that did not answer'); });
    socket.on('data', data => { message += data.toString(); });
    socket.on('end', () => done(message || 'another process'));
    socket.on('error', e => {
      const code = 'code' in e ? e.code : undefined;
      done(code === 'ECONNREFUSED' || code === 'ENOENT' ? undefined : `a process that could not be reached (${String(code)})`);
    });
  });
}

/** Takes the lock at `path` or throws LockBusy naming its holder. Anyone asking gets `describe()`'s answer. Returns the release. */
export async function takeLock(path: string, describe: () => string) {
  if (Buffer.byteLength(path) > LIMIT) throw new Error(`Lock path is ${Buffer.byteLength(path)} bytes, over this system's limit of ${LIMIT}. Set OPTCHAT_HOME to a shorter directory: ${path}`);
  const server = createServer(socket => { socket.on('error', () => socket.destroy()); try { socket.end(describe()); } catch { socket.destroy(); } });
  const listen = () => new Promise<void>((done, fail) => {
    const failed = (error: Error) => { server.off('listening', ready); fail(error); };
    const ready = () => { server.off('error', failed); done(); };
    server.once('error', failed); server.once('listening', ready); server.listen(path);
  });
  try { await listen(); }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EADDRINUSE') throw error;
    const before = existing(path);
    if (!before) throw new LockBusy('a process that just let go; try again');
    const owner = await holder(path);
    if (owner !== undefined) throw new LockBusy(owner);
    // Nothing answered, so the socket file is left over from a dead process. Remove it only if it is still the same file.
    if (before !== 'pipe') {
      let now; try { now = statSync(path); } catch { now = undefined; }
      if (now && now.ino !== before.ino) throw new LockBusy('a process that just took it');
      if (now) unlinkSync(path);
    }
    await listen();
  }
  if (!isWindows) { try { chmodSync(path, 0o600); } catch (error) { server.close(); throw error; } }
  let released: Promise<void> | undefined;
  return () => released ??= new Promise<void>(done => server.close(() => done()));
}

/** Takes the lock, waiting while someone else holds it, for up to `timeout`. */
export async function waitLock(path: string, describe: () => string, timeout = 60_000) {
  const until = Date.now() + timeout;
  for (let delay = 10; ; delay = Math.min(delay * 2, 250)) {
    try { return await takeLock(path, describe); }
    catch (error) {
      if (!(error instanceof LockBusy) || Date.now() + delay > until) throw error;
      await sleep(delay);
    }
  }
}

/** Runs `work` holding the lock at `path`. */
export async function withLock<T>(path: string, describe: () => string, work: () => T | Promise<T>, timeout?: number): Promise<T> {
  const release = await waitLock(path, describe, timeout);
  try { return await work(); } finally { await release(); }
}
