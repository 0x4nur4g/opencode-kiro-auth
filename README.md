# OpenCode Kiro Auth Plugin (OpenCode 2.x port)

OpenCode plugin for AWS Kiro (CodeWhisperer) providing access to Claude models plus
Kiro's other frontier models, with substantial trial quotas.

This is a port of [`tickernelz/opencode-kiro-auth`](https://github.com/tickernelz/opencode-kiro-auth)
(MIT, author `tickernelz`) to the OpenCode 2.x plugin contract. The upstream project
targets an older plugin API; this branch keeps its auth, request, storage and model
logic and replaces the plugin shell with the 2.x `{ id, setup }` surface.

## Features

- **Multiple Auth Methods**: AWS Builder ID (IDC) and IAM Identity Center (custom
  Start URL or Profile ARN), registered as OpenCode 2.x OAuth integrations with forms.
- **Auto-Sync Kiro CLI**: Imports and synchronizes active sessions from your local
  `kiro-cli` SQLite database on startup when `auto_sync_kiro_cli` is enabled.
- **Intelligent Account Rotation**: Prioritizes multi-account usage based on lowest
  available quota (`sticky`, `round-robin`, `lowest-usage`).
- **Gradual Context Truncation**: Reduces context size dynamically during retries to
  avoid error 400.
- **High-Performance Storage**: Accounts and usage in a local libSQL/SQLite database.
- **Native Thinking Mode**: Kiro's `reasoningContentEvent` streams through as
  `reasoning_content` deltas, declared per model with
  `compatibility.reasoningField = "reasoning_content"`.
- **Kiro Effort Mapping**: Model variants (`low`…`max`) set `thinkingConfig.thinkingBudget`,
  which the plugin maps to Kiro's native `effort` field.
- **Server-Side Web Search**: Exposes Kiro's `kiro_web_search` tool (Pro accounts).
- **Automated Recovery**: Exponential backoff for rate limits and automated token
  refresh.

## How the port works

The host gives a plugin an `openai-compatible` provider slot, not Kiro's native
request shape. So the plugin runs a **loopback gateway**:

- `setup` starts an HTTP server bound to `127.0.0.1` on an ephemeral port.
- The `kiro` provider is registered against `@opencode/ai/providers/openai-compatible`
  with `baseURL = http://127.0.0.1:<port>` and a sentinel `apiKey` (`kiro-gateway`).
- OpenCode sends OpenAI-shaped `POST /chat/completions` requests; the gateway hands
  them to the upstream `RequestHandler`, which signs and streams from Kiro.
- Kiro's `reasoningContentEvent` / tool-call events are translated back into OpenAI
  streaming chunks, and a final `finish_reason: "stop"` chunk always terminates the
  stream.

The gateway is a singleton per process with an ownership token: repeated `setup`
calls (hot reload, duplicate registration) reuse the listener, and only the run that
still owns it stops the server on dispose.

Host toasts are not part of the 2.x plugin surface. Notifications are written to the
plugin log instead (`<config-dir>/opencode/kiro-logs/plugin.log`), and request-time
failures (for example, no accounts) are returned as an assistant message on the
stream so the reason is visible in the session.

## Installation

Install the plugin's own dependencies first — the runtime resolves them from the
plugin directory:

```bash
cd /path/to/opencode-kiro-auth
bun install   # or: npm install
```

Then register the plugin in `opencode.json` / `opencode.jsonc` using the 2.x plugin
shape. A local checkout:

```json
{
  "plugins": [
    { "package": "/path/to/opencode-kiro-auth" }
  ]
}
```

A published git spec (once the fork has a repository):

```json
{
  "plugins": [
    { "package": "github:<owner>/<repo>" }
  ]
}
```

The plugin loads the entry file `index.ts` at the package root; no build step is
required for local development. Restart OpenCode to pick up changes.

## Setup

1. **Direct authentication (recommended)**

   - Run `opencode auth login` and select **Kiro**.
   - Choose a method:
     - **AWS Builder ID / IAM Identity Center** — optionally enter an IAM Identity
       Center Start URL and region; leave the Start URL blank for AWS Builder ID.
     - **IAM Identity Center with Profile ARN** — same fields plus a required
       `profile_arn`.
   - The default region is `us-east-1`. You can also pre-set `idc_start_url`,
     `idc_region` and `idc_profile_arn` in `<config-dir>/opencode/kiro.json`.
   - A browser opens to AWS's verification URL. If it does not, copy the URL and
     enter the code shown by OpenCode.

2. **Kiro CLI session import**

   - Log in with `kiro-cli login`.
   - With `auto_sync_kiro_cli: true` (default) the plugin imports and refreshes
     sessions from the Kiro CLI database on startup; no extra OpenCode login is
     needed once an account exists in the plugin database.

3. Accounts and usage are stored at `<config-dir>/opencode/kiro.db`.

## Models and thinking

The plugin advertises the Kiro registry (24 models at the time of writing) under the
`kiro` provider, including a `-thinking` companion for every effort-capable model.
Run `/models` and pick one. Defining `provider.kiro.models` yourself replaces the
plugin's registry entirely.

Each `-thinking` model declares:

```json
{
  "compatibility": { "reasoningField": "reasoning_content" }
}
```

That field tells OpenCode that reasoning arrives in the non-standard
`reasoning_content` delta the plugin emits. If you override the registry and drop it,
reasoning output is silently discarded.

Variants set `thinkingConfig.thinkingBudget`, mapped to Kiro's `effort`:

| OpenCode budget | Kiro effort |
| --------------- | ----------- |
| `<= 16384`      | `low`       |
| `<= 32768`      | `medium`    |
| `<= 65536`      | `high`      |
| `<= 98304`      | `xhigh`     |
| `> 98304`       | `max`       |

`xhigh` is only offered by opus-4.7, opus-4.8, opus-5 and sonnet-5; other thinking
models carry a four-variant ladder and clamp the `xhigh` band to `max`. Kiro's
GPT-5.6 tiers are not advertised (they need a different reasoning request shape).

## Configuration

Plugin-wide settings live in `<config-dir>/opencode/kiro.json` (on Linux/macOS that
is `~/.config/opencode/kiro.json`). A template is created on first run.

```json
{
  "auto_sync_kiro_cli": true,
  "account_selection_strategy": "lowest-usage",
  "default_region": "us-east-1",
  "idc_start_url": "https://your-company.awsapps.com/start",
  "idc_region": "us-east-1",
  "rate_limit_retry_delay_ms": 5000,
  "rate_limit_max_retries": 3,
  "max_request_iterations": 20,
  "request_timeout_ms": 120000,
  "token_expiry_buffer_ms": 300000,
  "usage_sync_max_retries": 3,
  "usage_tracking_enabled": true,
  "auto_effort_mapping": true,
  "web_search_enabled": true,
  "enable_log_api_request": false
}
```

- `auto_sync_kiro_cli`: Sync sessions from Kiro CLI (default `true`).
- `account_selection_strategy`: `sticky`, `round-robin` or `lowest-usage`.
- `default_region`: AWS region used when none is supplied (default `us-east-1`).
- `idc_start_url` / `idc_region` / `idc_profile_arn`: Defaults for IDC logins.
- `rate_limit_retry_delay_ms` (1000-60000), `rate_limit_max_retries` (0-10).
- `max_request_iterations` (5-1000), `request_timeout_ms` (30000-600000).
- `token_expiry_buffer_ms` (30000-300000), `usage_sync_max_retries` (0-5).
- `usage_tracking_enabled`: Usage tracking and quota-based rotation.
- `effort`: Global override for thinking effort (`low`, `medium`, `high`, `xhigh`,
  `max`).
- `auto_effort_mapping`: Map OpenCode thinking budgets onto Kiro effort (default
  `true`).
- `web_search_enabled`: Expose `kiro_web_search` when the account has a profile ARN
  (Pro). Billable as Kiro credits.
- `enable_log_api_request`: Log resolved request fields, including the effort level
  that went on the wire.

## Storage

**Linux/macOS**

- SQLite database: `~/.config/opencode/kiro.db`
- Plugin config: `~/.config/opencode/kiro.json`
- Plugin log: `~/.config/opencode/kiro-logs/plugin.log`

**Windows**

- SQLite database: `%APPDATA%\opencode\kiro.db`
- Plugin config: `%APPDATA%\opencode\kiro.json`

The paths follow OpenCode's config directory, so `XDG_CONFIG_HOME` /
`OPENCODE_CONFIG_DIR` overrides are honored.

## Troubleshooting

### Error: No accounts

The plugin has no usable account records.

1. Run `opencode auth login` and complete a Kiro login, or ensure `kiro-cli login`
   succeeds.
2. Ensure `auto_sync_kiro_cli` is `true` in `kiro.json`.
3. Retry a prompt; the failure comes back as an assistant message that says why.

### Error: Status: 403 (AccessDeniedException / User is not authorized)

With IAM Identity Center the Kiro APIs typically require a profile ARN.

1. Run `kiro-cli profile` and select a profile.
2. Re-authenticate with the **IAM Identity Center with Profile ARN** method, or set
   `idc_profile_arn` in `kiro.json` and restart OpenCode.

### Reasoning does not render

Thinking models need `compatibility.reasoningField: "reasoning_content"` in their
catalog record. The plugin sets it; a custom `provider.kiro.models` override must
carry it too.

### Checking plugin state

- `GET /api/plugin` shows `kiro` with `state.status: "active"`.
- `GET /api/model` lists the provider's models.
- `GET /api/integration` shows the Kiro OAuth methods.
- `<config-dir>/opencode/kiro-logs/plugin.log` holds notifications.

## Manual acceptance (real credentials)

The port was acceptance-tested against a live OpenCode 2.0.7 service with isolated
`HOME`/`XDG_*` and a stub credential store: plugin active, 24 models served through
the loopback provider, 2 OAuth methods with forms, and the gateway answering
`text/event-stream` with a terminating `finish_reason: "stop"` chunk. A real-account
run still needs credentials this environment does not have:

1. `bun install` in the plugin directory and register it in `opencode.json`.
2. `opencode auth login` → Kiro → method; complete the AWS browser flow.
3. `/models` → pick a `kiro` model (a `-thinking` one to exercise reasoning).
4. Send a short prompt; confirm the answer streams and, on a thinking model, that a
   reasoning block renders.
5. Optional: `/models` → enable `kiro_web_search` and ask a current-events question.

## Development

```bash
bun install
bun run typecheck   # tsc --noEmit
bun test            # unit tests
bun run format      # prettier
```

## Limitations

- Host toasts are unavailable on the 2.x plugin surface; notifications go to the
  plugin log and assistant messages.
- The loopback gateway binds an ephemeral port on `127.0.0.1`; the sentinel `apiKey`
  (`kiro-gateway`) is a placeholder, not a secret, and the port stays local.
- Only two OAuth integration methods are registered (Builder ID/IDC and IDC with
  Profile ARN); Kiro CLI sessions are imported through sync rather than a third
  method.

## Acknowledgements

Forked from [`tickernelz/opencode-kiro-auth`](https://github.com/tickernelz/opencode-kiro-auth)
(MIT), which in turn credits
[AIClient-2-API](https://github.com/justlovemaki/AIClient-2-API) for the foundational
Kiro authentication logic and request patterns.

## Disclaimer

This plugin is provided strictly for learning and educational purposes. It is an
independent implementation and is not affiliated with, endorsed by, or supported by
Amazon Web Services (AWS) or Anthropic. Use of this plugin is at your own risk.

## License

MIT (as declared in `package.json`); upstream copyright belongs to the original
author, `tickernelz`.
