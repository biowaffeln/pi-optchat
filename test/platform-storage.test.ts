import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite } from '../src/store.ts';
import { removeDir } from './support.ts';

test('a failed file flush preserves the previous state and a subsequent write recovers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-flush-'));
  try {
    const file = join(dir, 'state.json'), failure = new Error('injected file flush failure');
    atomicWrite(file, 'previous committed value');
    const flush = mock.method(fs, 'fsyncSync', () => { throw failure; });
    syncBuiltinESMExports();
    assert.throws(() => atomicWrite(file, 'uncommitted replacement'), error => error === failure);
    assert.equal(readFileSync(file, 'utf8'), 'previous committed value');
    flush.mock.restore(); syncBuiltinESMExports();
    atomicWrite(file, 'recovered');
    assert.equal(readFileSync(file, 'utf8'), 'recovered');
    assert.deepEqual(readdirSync(dir), ['state.json']);
  } finally { mock.restoreAll(); syncBuiltinESMExports(); removeDir(dir); }
});
