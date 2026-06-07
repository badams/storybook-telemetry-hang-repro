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
(`core/src/telemetry/telemetry.ts`). If the connection stalls — a slow or
degraded `storybook.js.org/event-log` — the `fetch` never settles, the `await`
never returns, and the open socket keeps the Node event loop alive. The
`try/catch` around the call does not help: a stall never *rejects*, so there is
nothing to catch.

In CI this looks like a build that prints success (or gets close to it) and then
sits until the job's wall-clock limit kills it. With chromatic-cli it surfaces as
`Command timed out after 600000ms` (`CLI_STORYBOOK_BUILD_FAILED`).

## Reproduce it in CI

This repo reproduces the telemetry timeout issue **naturally**, with a real
`chromatic --dry-run` against the live telemetry endpoint, across four GitHub
Actions workflows. Each runs `npx chromatic --dry-run` over a 50-job matrix (one
attempt per job, executed one at a time to stay under chromatic's rate limit); a
job goes **red** when the storybook build overruns chromatic's build timeout
(`STORYBOOK_BUILD_TIMEOUT=120000`), i.e. the telemetry POST stalled.

- [`telemetry-timeout-repro-node26.yml`](.github/workflows/telemetry-timeout-repro-node26.yml)
  — **Node 26**, unpatched. The primary repro
  ([example failing run](https://github.com/badams/storybook-telemetry-hang-repro/actions/runs/27090256636)
  — 23 of 50 attempts timed out).
- [`telemetry-timeout-repro-node25.yml`](.github/workflows/telemetry-timeout-repro-node25.yml)
  — **Node 25**, unpatched. The version reported in
  [storybookjs/storybook#34446](https://github.com/storybookjs/storybook/issues/34446).
- [`telemetry-timeout-repro-node22.yml`](.github/workflows/telemetry-timeout-repro-node22.yml)
  — **Node 22**, unpatched. Node-version comparison.
- [`telemetry-timeout-repro-node26-patched.yml`](.github/workflows/telemetry-timeout-repro-node26-patched.yml)
  — **Node 26**, with the upstream fix applied via `patch-package`
  ([`patches/storybook+10.4.1.patch`](patches/storybook+10.4.1.patch)). The fix
  adds `signal: AbortSignal.timeout(30_000)` so a stalled POST aborts instead of
  pinning the build open.

## Results

Each workflow ran 50 attempts (one per matrix job, executed serially) on
2026-06-07 (commit `18da431`). A "telemetry timeout" is an attempt where
chromatic killed the storybook build at its timeout — exit code `105` /
`Command timed out after 120000ms` / `CLI_STORYBOOK_BUILD_FAILED`.

| Workflow | Node | Fix applied | Valid attempts | Telemetry timeouts | Timeout rate | Run |
| --- | :-: | :-: | :-: | :-: | :-: | :-: |
| `telemetry-timeout-repro-node26` | 26 | no | 50 | 23 | **46%** | [run](https://github.com/badams/storybook-telemetry-hang-repro/actions/runs/27090256636) |
| `telemetry-timeout-repro-node25` | 25 | no | 50 | 3 | **6%** | [run](https://github.com/badams/storybook-telemetry-hang-repro/actions/runs/27090256639) |
| `telemetry-timeout-repro-node22` | 22 | no | 49 | 0 | **0%** | [run](https://github.com/badams/storybook-telemetry-hang-repro/actions/runs/27090256648) |
| `telemetry-timeout-repro-node26-patched` | 26 | yes | 49 | 0 | **0%** | [run](https://github.com/badams/storybook-telemetry-hang-repro/actions/runs/27090256642) |

Takeaways:

- **Node 26 reproduces the issue naturally ~1 in 2 attempts** (23/50) against the
  live endpoint. The stalls are spread evenly across the whole run, not clustered
  in one degraded window — so the rate is intrinsic, not a timing artifact.
- **The rate jumps ~8× from Node 25 (6%) to Node 26 (46%)** — a sharp regression
  between two adjacent newer majors, not a gradual "newer is worse." This points
  at a specific runtime change (likely the bundled `undici`/`fetch` socket
  handling) landing in Node 26.
- **Node 22 never reproduced it** (0/49): older Node recovers from a slow/stalled
  telemetry connection where newer Node hangs permanently.
- **The fix eliminates it on Node 26** (0/49): with the 30s `AbortSignal` the
  build always exits.

> Two attempts (one Node 22, one patched) failed instead with chromatic's *own*
> TLS/connection error (exit code `255`, a transient chromatic-side rate limit)
> rather than a build timeout. These are a different failure mode and are
> excluded from the counts above as invalid samples.

### Control: prove it is the telemetry call

Disable telemetry and the same build exits cleanly in seconds:

```bash
STORYBOOK_DISABLE_TELEMETRY=1 npx storybook build
echo "exit: $?"   # 0, returns immediately
```

## Notes

- Against the live telemetry endpoint the reproduction is strongly **Node-version
  dependent** (see Results): Node 26 ~46%, Node 25 ~6%, Node 22 ~0%. The root
  cause is the missing `fetch` timeout, but whether a slow/stalled connection
  becomes a *permanent* stall depends on the Node runtime — newer Node hangs,
  older Node recovers.
- Keep `STORYBOOK_DISABLE_TELEMETRY` unset when reproducing; that env var is what
  the control run uses to bypass the buggy code path.

## Links

- Upstream issue: _TODO_
- Upstream fix PR: _TODO_
- Related reports: storybookjs/storybook#34446, storybookjs/storybook#29828, storybookjs/storybook#24303
