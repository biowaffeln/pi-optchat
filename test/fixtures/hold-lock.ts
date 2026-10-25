// Takes the lock named on the command line and holds it until killed (test/branch.test.ts).
import { takeLock } from '../../src/locks.ts';
await takeLock(process.argv[2], () => 'child');
process.send?.('held');
setInterval(() => {}, 1000);
