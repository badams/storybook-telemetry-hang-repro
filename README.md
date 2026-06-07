# Storybook telemetry build-hang reproduction

Minimal, deterministic reproduction of a bug where **`storybook build` hangs
forever instead of exiting** when Storybook's telemetry endpoint stalls.

- Storybook: `10.4.1` (react-vite)
- Trigger: a telemetry endpoint that accepts the connection but never responds
- Symptom: the build finishes compiling, then the process never exits

## The bug

After a successful build, Storybook posts an anonymous telemetry event and
**awaits** it:

```ts
// node_modules/storybook/.../core-server/build-static.ts
await telemetry('build', payload, { configDir: options.configDir });
```

That POST is a `fetch` with **no timeout / `AbortSignal`**
(`core/src/telemetry/telemetry.ts`). If the connection stalls — a blackholed or
degraded `storybook.js.org/event-log`, a proxy that swallows the request — the
`fetch` never settles, the `await` never returns, and the open socket keeps the
Node event loop alive. The `try/catch` around the call does not help: a hang
never *rejects*, so there is nothing to catch.

In CI this looks like a build that prints success (or gets close to it) and then
sits until the job's wall-clock limit kills it. With chromatic-cli it surfaces as
`Command timed out after 600000ms` (`CLI_STORYBOOK_BUILD_FAILED`).

## Reproduce it locally

```bash
npm install
node harness.mjs          # CAP_SECONDS=120 by default; try CAP_SECONDS=20 for a quick run
```

`harness.mjs`:

1. starts a "blackhole" TCP server that accepts + reads but never replies,
2. points Storybook at it via `STORYBOOK_TELEMETRY_URL`,
3. runs `storybook build` and watches it.

Expected output: the build compiles in ~2s, and then the harness reports that the
process is **still alive** at the cap — `HANG REPRODUCED` — and exits 0.

### Control: prove it is the telemetry call

Disable telemetry and the same build exits cleanly in seconds:

```bash
STORYBOOK_DISABLE_TELEMETRY=1 npx storybook build
echo "exit: $?"   # 0, returns immediately
```

## Reproduce it in CI

The [`Reproduce telemetry build hang`](../../actions) workflow runs the harness on
Node 26 (ubuntu) and uploads the build log. The job is **green when the hang is
reproduced**; the evidence is in the log (compilation finishes, process pinned for
120s). If a future Storybook release fixes the missing timeout, the build will
exit on its own and the job turns red — a signal that this repro is stale.

## Notes

- Node 26 matches where this was first seen, but the hang is **not**
  Node-specific — it is a missing fetch timeout and reproduces on any supported
  Node version.
- Keep `STORYBOOK_DISABLE_TELEMETRY` unset when reproducing; that env var is what
  the control run uses to bypass the buggy code path.

## Links

- Upstream issue: _TODO_
- Upstream fix PR: _TODO_
- Related reports: storybookjs/storybook#29828, storybookjs/storybook#24303
