# Storybook telemetry timeout issue repro

Minimal, deterministic reproduction of a bug where **`storybook build` stalls
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
Node event loop alive. The `try/catch` around the call does not help: a stall
never *rejects*, so there is nothing to catch.

In CI this looks like a build that prints success (or gets close to it) and then
sits until the job's wall-clock limit kills it. With chromatic-cli it surfaces as
`Command timed out after 600000ms` (`CLI_STORYBOOK_BUILD_FAILED`).

## Reproduce it in CI

This repo reproduces the telemetry timeout issue **naturally** — no blackhole,
just a real `chromatic --dry-run` against the live telemetry endpoint — across
two GitHub Actions workflows:

- [`telemetry-timeout-repro-node26.yml`](.github/workflows/telemetry-timeout-repro-node26.yml)
  — runs `npx chromatic --dry-run` across 10 parallel matrix jobs (one attempt
  each) on **Node 26**. A job goes **red** when it catches the stall (the
  chromatic build timeout fires).
- [`telemetry-timeout-repro-node22.yml`](.github/workflows/telemetry-timeout-repro-node22.yml)
  — same repro on **Node 22**, for a node-version frequency comparison.

So far the issue reproduces on Node 26 but not Node 22 — strong evidence that
newer Node turns a stalled telemetry connection into a permanent stall where
older Node eventually recovers.

### Control: prove it is the telemetry call

Disable telemetry and the same build exits cleanly in seconds:

```bash
STORYBOOK_DISABLE_TELEMETRY=1 npx storybook build
echo "exit: $?"   # 0, returns immediately
```

## Notes

- Node 26 matches where this was first seen, but the issue is **not**
  Node-specific — it is a missing fetch timeout and reproduces on any supported
  Node version.
- Keep `STORYBOOK_DISABLE_TELEMETRY` unset when reproducing; that env var is what
  the control run uses to bypass the buggy code path.

## Links

- Upstream issue: _TODO_
- Upstream fix PR: _TODO_
- Related reports: storybookjs/storybook#29828, storybookjs/storybook#24303
