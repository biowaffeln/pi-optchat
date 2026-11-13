import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';

let cached: string | undefined;

/** An id for this computer that survives renames and network changes, unlike `os.hostname()`, which macOS can take
 * from DHCP or reverse DNS when no HostName is set. Falls back to the hostname where the OS offers nothing better. */
export function machineId(): string {
  if (cached !== undefined) return cached;
  cached = readMachineId() ?? `host:${hostname()}`;
  return cached;
}

function readMachineId(): string | undefined {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 5000 });
      const uuid = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out)?.[1];
      return uuid ? `mac:${uuid}` : undefined;
    }
    if (process.platform === 'linux') {
      for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        try { const id = readFileSync(path, 'utf8').trim(); if (id) return `linux:${id}`; } catch { /* try the next one */ }
      }
      return undefined;
    }
    if (process.platform === 'win32') {
      const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf8', timeout: 5000 });
      const guid = /MachineGuid\s+REG_SZ\s+(\S+)/.exec(out)?.[1];
      return guid ? `win:${guid}` : undefined;
    }
  } catch { /* fall back to the hostname */ }
  return undefined;
}
