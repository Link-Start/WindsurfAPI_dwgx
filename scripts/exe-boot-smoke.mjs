#!/usr/bin/env node
/**
 * Boot-smoke a packaged single-file binary.
 *
 * The pkg build can succeed and still ship a broken binary: the ESM→CJS bundle
 * step or the `pkg.assets` list can silently drop the dashboard HTML / i18n /
 * catalog JSON, and that only shows up at runtime. So the gate is "does it boot
 * and serve", not "did pkg exit 0":
 *   - GET /health must answer 200 (server up, config loaded)
 *   - GET /dashboard must answer 200 (asset bundling intact)
 *
 * This logic used to live inline in .github/workflows/release.yml, duplicated
 * across the arm64 / x64 / windows jobs, with no way to run it locally before
 * pushing a tag. The two macOS jobs now call this script; the **Windows job still
 * carries its own inline PowerShell smoke** (Start-Process + Invoke-WebRequest +
 * Stop-Process), so this file is the local check for every platform and the CI
 * check for macOS only. Wiring the Windows job to it would make the two agree —
 * the file has to keep working there for that to be worth doing.
 *
 * Usage:
 *   node scripts/exe-boot-smoke.mjs [path-to-binary]
 *
 * Default path is the current platform's expected output. Exits non-zero with a
 * diagnostic on failure.
 *
 * Note: the binary writes a generated `.env` (API_KEY + DASHBOARD_PASSWORD) next
 * to itself on first run — see src/config.js. Running this against a build in the
 * dist directories therefore leaves that file in the build directory; the release
 * zip names the files it copies, so it is not published, but do not hand-zip the
 * directory without excluding it.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.SMOKE_PORT || 3999);
const BOOT_TIMEOUT_MS = Number(process.env.SMOKE_BOOT_TIMEOUT_MS || 20000);

function defaultBinary() {
  if (process.platform === 'win32') return 'dist-windows/windsurfapi.exe';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return `dist-macos/windsurfapi-macos-${arch}`;
}

const binary = process.argv[2] || defaultBinary();

if (!existsSync(binary)) {
  console.error(`✖ binary not found: ${binary}`);
  console.error('  build it first, e.g. `npm run build:exe:macos`');
  process.exit(1);
}

if (process.platform !== 'win32') {
  try { chmodSync(binary, 0o755); } catch { /* best-effort */ }
}

const dataDir = mkdtempSync(join(tmpdir(), 'wa-smoke-'));
let child = null;

async function cleanup() {
  if (child && child.exitCode === null) {
    // Wait for the child to actually go away before the process exits. Killing and
    // calling process.exit() in the same tick races libuv's handle close on Windows
    // and aborts the process with `Assertion failed: !(handle->flags &
    // UV_HANDLE_CLOSING), file src\win\async.c, line 94` — after the smoke has
    // already printed OK, so a successful run reported exit 9.
    const gone = new Promise((resolve) => child.once('exit', resolve));
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, 5000))]);
  }
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

async function probe(path) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.status;
  } catch {
    return 0;
  }
}

async function main() {
  console.log(`▶ boot-smoke ${binary} (port ${PORT}, DATA_DIR ${dataDir})`);
  child = spawn(binary, [], {
    env: {
      ...process.env,
      DEVIN_CONNECT: '1',
      HOST: '127.0.0.1',
      PORT: String(PORT),
      API_KEY: 'ci-smoke',
      DATA_DIR: dataDir,
      WINDSURFAPI_NO_OPEN: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (d) => { output += d.toString(); });
  child.stderr.on('data', (d) => { output += d.toString(); });

  let exitedEarly = null;
  child.on('exit', (code, signal) => { exitedEarly = signal || code; });

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let health = 0;
  while (Date.now() < deadline) {
    if (exitedEarly !== null) break;
    health = await probe('/health');
    if (health === 200) break;
    await new Promise(r => setTimeout(r, 500));
  }

  if (exitedEarly !== null) {
    console.error(`✖ the binary exited before serving (${exitedEarly})`);
    console.error(output.slice(-2000));
    return 1;
  }
  if (health !== 200) {
    console.error(`✖ /health did not answer 200 within ${BOOT_TIMEOUT_MS}ms (last: ${health})`);
    console.error(output.slice(-2000));
    return 1;
  }
  console.log('  ✓ /health 200');

  // Served from pkg.assets — a missing entry there builds fine and 404s here.
  const dash = await probe('/dashboard');
  if (dash !== 200) {
    console.error(`✖ /dashboard answered ${dash} — asset bundling is broken (check pkg.assets)`);
    console.error(output.slice(-2000));
    return 1;
  }
  console.log('  ✓ /dashboard 200 (assets bundled)');

  console.log('✔ boot-smoke OK');
  return 0;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  console.error(`✖ smoke failed: ${err?.message || err}`);
} finally {
  await cleanup();
}
// Set the code and let the loop drain. `process.exit(code)` here aborted the process
// with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` (src\win\async.c:94)
// on Windows because the fetch/child handles were still closing — so a *passing*
// smoke reported exit 9, which is worse than a failing one: the only way to keep a
// release moving was to ignore the exit code. The failure paths still exit non-zero,
// and the child is awaited in cleanup() so the loop cannot hang on it.
process.exitCode = code;
