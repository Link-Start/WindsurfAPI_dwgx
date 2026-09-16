#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { listTopLevelTestFiles } from './run-test-shard.mjs';

// npm test keeps Node's normal multi-file runner and concurrency. Only discovery changes;
// test:release remains the serial, timed, one-process-per-file authority.
const files = listTopLevelTestFiles();
if (!files.length) {
  console.error('npm test selected zero test files');
  process.exitCode = 2;
} else {
  console.log(`TEST_DISCOVERY ${files.length} unique files`);
  const child = spawn(process.execPath, ['--import', './test/setup-env.mjs', '--test', ...process.argv.slice(2), ...files], {
    cwd: process.cwd(), env: process.env, stdio: 'inherit',
  });
  child.on('error', error => { console.error(`npm test spawn failure: ${error.message}`); process.exitCode = 2; });
  child.on('close', (code, signal) => { process.exitCode = signal ? 2 : code ?? 2; });
}
