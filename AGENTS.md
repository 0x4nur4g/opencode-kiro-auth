# kiro-auth-v2 — agent brief

Fork of `tickernelz/opencode-kiro-auth` (MIT), ported from the OpenCode V1 plugin contract to the
V2 contract. Branch `v2-port`. You should be able to work from this file alone.

## Scope and ground rules

- **V2 only.** Target runtime is OpenCode 2.x. Never add V1 support or V1-shaped exports
  (`async (input) => ({ config, auth, provider, tool })` is dead on 2.x and is rejected outright).
- **Do not push, publish, or create remotes/repos.** `origin` still points at upstream. The user's
  fork URL is unknown. `package.json` stays `"private": true` until the user picks an npm scope/name.
- **Do not touch `~/.config/opencode/**` or the user's live service** unless explicitly asked.
- Commit identity is already set repo-local: `0x4nur4g <0x4nur4g@users.noreply.github.com>`.
  Do not invent personal/employer identities.
- Scratch only under `/tmp/opencode/`. Kill every server you start, verify ports are free.
- One writer per directory at a time. No whole-file rewrites when a surgical edit works.
- Sanitized logs only: no token/credential values, ever.

## Where the truth lives

OpenCode work in this workspace has a docs-first gate. Consult these before guessing:

| Path (absolute) | Holds |
| --- | --- |
| `/home/scan/tools/opencode-plugins/docs/opencode-v2-plugin-auth-and-aisdk-surfaces-2.0.6.md` | Verified auth + transport contract, port design decisions, acceptance record. **Primary reference.** |
| `/home/scan/tools/opencode-plugins/docs/opencode-v2-plugin-v1-shape-rejection-2.0.6.md` | Why the V1 module shape fails on 2.x, with exact rejection strings. |
| `/home/scan/tools/opencode-plugins/docs/opencode-v2-model-surface-2.0.4.md` | `ctx.model` / `ctx.provider` shapes, catalog upsert. |
| `/home/scan/tools/opencode-plugins/docs/opencode-v2-plugin-loading-and-config-shapes.md` | Registration forms, entry resolution. |
| `/home/scan/tools/opencode-plugins/docs/opencode-v2-package-scope-rename-2.0.5.md` | `@opencode/*` (not `@opencode-ai/*`) type artifacts. |
| `/home/scan/tools/opencode-plugins/docs/opencode-v2-plugin-raw-object-export.md` | Default-export contract. |

**Upstream source is the tie-breaker.** A full `sst/opencode` clone (tag `v2.0.6`) sits in scratch at
`/tmp/opencode/kiro-port-probe/src-recon/op-repo` — authoritative for host behavior. Scratch is
ephemeral: if it is gone, re-clone `sst/opencode` at the matching tag. Key files:

- `packages/plugin/src/promise/*.ts` — the promise plugin flavor and its **declared** types.
- `packages/plugin/src/promise/adapter.ts` — promise plugin → Effect host adapter (where mismatches bite).
- `packages/core/src/integration.ts` — oauth attempt lifecycle (`authorize`, `settle`, `callback`).

Runtime-verified behavior beats docs and type packages. If the runtime contradicts a doc, fix the doc.

## Architecture

```
index.ts                 # default export { id: 'kiro', setup }
src/index.ts             # re-exports
src/v2/plugin.ts         # setup(): wires auth + provider/models + tool + gateway; idempotent
src/v2/auth.ts           # integration `kiro` + 2 oauth methods (builder-id, idc-profile-arn)
src/v2/catalog.ts        # Model.Info records (24 models) + thinking variants
src/v2/gateway.ts        # loopback OpenAI-compatible SSE server (Bun.serve, 127.0.0.1, ephemeral)
src/v2/tools.ts          # kiro_web_search tool
src/v2/context.ts        # context helpers
src/v2/host-types.ts     # ambient local host types (NO @opencode-ai/* runtime imports)
src/core/**, src/plugin/**, src/kiro/**   # upstream Kiro domain logic, retained
```

Deleted from upstream: `src/plugin.ts` (V1 factory), `src/plugin/auth-page.ts`,
`src/plugin/auth-bootstrap.ts`, husky/lint-staged, `package-lock.json`.

Design decisions (full rationale in the primary doc):

- **Transport = loopback gateway.** A plugin cannot ship a custom `fetch` (model `settings` are
  JSON-validated), and the `ctx.aisdk` hooks never fire for openai-compatible models. So the plugin
  serves OpenAI SSE on loopback and the provider record sets `settings.baseURL` to it. The gateway
  rewrites the incoming URL to the upstream `https://q.<region>.amazonaws.com/...` shape.
- **Auth = `ctx.integration.transform`.** Two oauth methods with declarative `form` fields
  (`start_url`, `idc_region`, `profile_arn`). `authorize` reuses the upstream device-code flow;
  the returned `callback` yields `Credential.OAuth`; `refresh` maps to `refreshAccessToken`.
  The upstream sqlite store stays the account source of truth.
- **Toasts are gone.** No server-side notification surface exists; reauth prompts surface as request
  errors that point at `opencode auth login`.

## Contract traps (cost real debugging time — read before editing)

1. **Promise-flavor oauth `mode: "auto"` carries a Promise VALUE, not a function.**
   `packages/plugin/src/promise/integration.ts`:
   `{ mode: "auto"; callback: Promise<Credential.OAuth> }` vs
   `{ mode: "code"; callback: (code: string) => Promise<Credential.OAuth> }`.
   The host adapts it as `Effect.promise(() => authorization.callback)`. Hand back a *function* and
   the host calls `.then` on that function: login dies with
   `E(()=>e(r)).then is not a function` (hit live on 2.0.7, 2026-09-18).
   Fixed by `toHostAuthorization()` in `src/v2/auth.ts` — keep the eager promise, keep the
   `callback.catch(() => {})` guard, and keep `src/__tests__/` coverage for the shape
   (regression guard: `src/__tests__/oauth-callback-shape.test.ts`).
2. `setup` may run more than once per process (hot reload / duplicate registration). Keep the
   gateway a process singleton and every registration idempotent.
3. Transform callbacks (`provider`, `model`, `tool`, `integration`) are deferred and replay very
   often. Bodies must be cheap, total, and guarded. An incomplete `Model.Info` poisons the catalog
   for **all** plugins (`time.released`, `limit`, `capabilities`, `variants`, `cost`, `status`,
   `enabled` must all be present).
4. Tool registration takes ONE object argument: `ctx.tool.transform(e => e.add(tool))`. The 3-arg
   form crashes.
5. Gateway SSE must emit a terminating `finish_reason` chunk, or the runtime retries ~5× and fails
   the turn with `provider.invalid-output`.
6. Dir-target plugins resolve only the root `index.ts`; `package.json` must sit beside it;
   `main`/`exports` are ignored. `/api/plugin` is lazy — poll it, and use `/api/info` for identity
   (`/api/health` does not exist on 2.x).

## Gates

```bash
bun install                       # node_modules is required (tsc lives here)
bun run typecheck                 # must be 0 errors
bun test                          # baseline: 181 pass / 0 fail / 585 expects, 20 files (2026-09-21)
```

Live isolated probe (never against the user's service):

```bash
run=/tmp/opencode/<your-probe>            # HOME/XDG_*/OPENCODE_CONFIG all under $run
env HOME=$run/home XDG_DATA_HOME=$run/data XDG_STATE_HOME=$run/state \
    XDG_CACHE_HOME=$run/cache XDG_CONFIG_HOME=$run/xdg OPENCODE_CONFIG=$run/opencode.json \
    /home/scan/.opencode/bin/opencode serve --port <free> --hostname 127.0.0.1
```

- Password comes from serve stdout; call the API with `curl -u "opencode:$PW"` (or `opencode api`).
- Register with `{"plugins":[{"package":"/abs/dir"}]}`. Validate the harness with a trivial
  `{id, setup}` control plugin first.
- **Caveat:** Bun's `homedir()` ignores `$HOME`, so plugin-owned files (`kiro.json`, `kiro.db`,
  `kiro-logs/`) can land in the real `~/.config/opencode/` even under isolation. Check and clean up.
- Kill the server (`/proc/<pid>/cwd` first) and leave ports free.

Real end-to-end (actual completion) needs a Kiro account: `opencode auth login` → Kiro → Builder ID
or IAM Identity Center. Not reproducible on a box without Kiro credentials. On headless machines
`xdg-open` fails — the verification URL and code must be opened manually.

## Current state (verify against disk; evidence over self-report)

- Last code commit is `91b2bcf` ("test: pin oauth auto-mode callback as thenable value");
  before it `e8bb79d` ("fix: surface zero-delta upstream streams as retryable errors"),
  `e5a9c29` (oauth `mode:"auto"` promise-value fix) and `8d4407b` (V2 port). Docs-only
  commits may sit above the last code commit.
- Live acceptance (2.0.7, isolated): plugin `active`, 24 kiro models, 2 oauth methods, gateway SSE
  correct without credentials. Evidence: `/tmp/opencode/kiro-port-probe2/accept/` (ephemeral).
- The plugin is registered in the user's live config as a local dir path and loads there.
- Empty-stream guard (2026-09-21, `e8bb79d`): zero-delta upstream terminations now emit a
  mid-stream chunk-level `error` event instead of the success terminal, so the host classifies
  them UnknownProviderError (retryable) instead of persisting a silent empty assistant turn.
  Both `transformSdkStream` and `transformKiroStream` are guarded; gateway create/reuse
  lifecycle log lines (with port) write to `kiro-logs/plugin.log`. Tests: 8 guard cases +
  1 converter case. Design + host citations:
  `docs/opencode-v2-plugin-load-logs-and-empty-completions.md` (workspace docs, Resolution
  section). Live wire verified 2026-09-21 — see the wire-verification bullet below.
- Wire verification (2026-09-21, isolated probe, opencode v2.0.11, evidence:
  `/tmp/opencode/kiro-host-err-probe/`, ephemeral): the host honors the mid-stream chunk-level
  `error` object after 200 headers, classifies `provider.unknown`, and retries (10 attempts,
  jittered exponential backoff, 2s→10s cap). The probe's control arm showed the host has no
  zero-content guard of its own (a stream terminating with neither content nor an error chunk
  is accepted as a successful empty turn), so the plugin-side guard remains necessary. An
  independent verifier reproduced the verdict from the isolated probe DB.
- **Open work:** (a) live probe of `POST /api/integration/oauth/connect` to confirm the login path
  no longer throws (the fix is typecheck/test-verified, not yet live-verified); (b) real-credential
  completion; (c) fork URL + npm scope/name decision.
