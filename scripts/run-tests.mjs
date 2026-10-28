// Runs every tests/*.test.js with the built-in Node test runner.
// Listing the files ourselves avoids glob handling, which differs between
// Node 20 (no glob support in `node --test`) and Node 22+.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const files = readdirSync('tests').filter((f) => f.endsWith('.test.js')).sort().map((f) => `tests/${f}`);
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
