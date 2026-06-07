// Reproduces the Storybook telemetry build-hang deterministically and
// cross-platform (no GNU `timeout` needed).
//
// It starts a "blackhole" TCP server that accepts the telemetry POST but never
// replies, points Storybook's telemetry at it via STORYBOOK_TELEMETRY_URL, then
// runs `storybook build` and watches what happens:
//
//   - buggy Storybook: the build prints "completed successfully", but the
//     post-build telemetry fetch has no timeout, so the stalled connection pins
//     the event loop and the process never exits. After CAP_SECONDS we detect
//     that, report the hang, and exit 0 (the reproduction succeeded).
//   - fixed Storybook: the telemetry fetch is time-boxed, so the process exits
//     on its own shortly after completing. We report that and exit 1 (nothing to
//     reproduce on this version).
import { spawn } from 'node:child_process';
import net from 'node:net';

const CAP_SECONDS = Number(process.env.CAP_SECONDS || 120);
const PORT = Number(process.env.BLACKHOLE_PORT || 9999);
const TELEMETRY_URL = `http://127.0.0.1:${PORT}/event-log`;

// Accept the connection, read bytes, never reply — a stalled telemetry endpoint.
const blackhole = net.createServer((socket) => {
  socket.on('data', () => {});
  socket.on('error', () => {});
});
await new Promise((resolve) => blackhole.listen(PORT, '127.0.0.1', resolve));
console.log(`[harness] blackhole telemetry endpoint listening at ${TELEMETRY_URL}`);
console.log(`[harness] cap: ${CAP_SECONDS}s\n`);

const started = Date.now();
const elapsed = () => ((Date.now() - started) / 1000).toFixed(1);

// Telemetry is the code path under test, so make sure it stays enabled.
const env = { ...process.env, STORYBOOK_TELEMETRY_URL: TELEMETRY_URL };
delete env.STORYBOOK_DISABLE_TELEMETRY;

let buildCompleted = false;

const child = spawn('npm', ['run', 'build-storybook'], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true, // own process group, so we can kill the whole tree on hang
});

// The compilation finishes (Vite/webpack prints its "built" line) before the
// post-build `await telemetry('build', ...)` runs, so this marks "the build did
// its work" — after which a healthy process exits within a second or two.
const onChunk = (buf) => {
  const text = buf.toString();
  process.stdout.write(text);
  if (!buildCompleted && /✓ built in|build completed successfully/i.test(text)) {
    buildCompleted = true;
    console.log(
      `\n[harness] build finished compiling at ${elapsed()}s — now watching whether the process exits...\n`
    );
  }
};
child.stdout.on('data', onChunk);
child.stderr.on('data', onChunk);

const killTree = (signal) => {
  try {
    process.kill(-child.pid, signal);
  } catch {
    // already gone
  }
};

const timer = setTimeout(() => {
  const line = '='.repeat(64);
  console.log(`\n[harness] ${line}`);
  if (buildCompleted) {
    console.log('[harness] HANG REPRODUCED');
    console.log(
      `[harness] The build finished compiling but the process was still alive ${CAP_SECONDS}s`
    );
    console.log(
      '[harness] later. The post-build `await telemetry(\'build\', ...)` POST has no timeout,'
    );
    console.log(
      '[harness] so the stalled connection never settles, the await never returns, and the'
    );
    console.log('[harness] CLI never exits. (Its try/catch cannot help — a hang never rejects.)');
  } else {
    console.log('[harness] STILL RUNNING after the cap, but the build never reported');
    console.log('[harness] success — cannot cleanly attribute this to the telemetry hang.');
  }
  console.log(`[harness] ${line}`);
  killTree('SIGKILL');
  blackhole.close();
  // A reproduced hang is the goal of this repo, so exit 0 when we see it.
  process.exit(buildCompleted ? 0 : 2);
}, CAP_SECONDS * 1000);

child.on('exit', (code, signal) => {
  clearTimeout(timer);
  blackhole.close();
  console.log(
    `\n[harness] build process exited on its own at ${elapsed()}s (code=${code}, signal=${signal}).`
  );
  if (buildCompleted) {
    console.log('[harness] No hang: the build exited promptly after completing.');
    console.log('[harness] This Storybook version is NOT affected (telemetry fetch is time-boxed).');
    process.exit(1); // pinned to a buggy version but it did not hang -> repro failed
  }
  process.exit(code ?? 0);
});
