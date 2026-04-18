# aivion-qa

**Local-first, AI-optional, end-to-end QA for web apps. Postgres-backed, plug-in auth.**
Write YAML plans. Run Playwright. Get a report. No cloud, no dashboard, no per-run LLM tax.

```bash
npm install -g @aivionlabs/qa
aivion-qa install-browsers
aivion-qa init
aivion-qa doctor
aivion-qa run smoke --headed
```

---

## Why

Every AI QA tool shipped today is cloud-hosted with a recorder or proprietary DSL. None reach `localhost:3000` + local Docker Postgres natively. None ship auth/DB adapters. `aivion-qa` does all of that and runs where your code does — your laptop.

**Principles:**
- **Local-first.** Runs on your machine against your stack. Reports stay on disk.
- **YAML-only plans.** Zero DSL, zero compile step, no LLM cost for reading plans.
- **Zero LLM by default.** Playwright + SQL + Zod are enough. LLM is opt-in for fuzzy assertions.
- **Observe, don't orchestrate.** The tool tests what you have running. It doesn't start your app, configure your auth provider, or run migrations.

---

## What it does (and doesn't)

| aivion-qa's job                                             | Your job                                              |
| ----------------------------------------------------------- | ----------------------------------------------------- |
| Mint test users via your auth provider's admin API          | Keep Clerk / Auth0 / etc. configured correctly        |
| Query DB for observable state                               | Keep DB migrations applied                            |
| Drive the browser via Playwright                            | Keep the app running on the expected port             |
| Intercept browser network calls                             | Keep ngrok / tunnels up if needed                     |
| Hit HTTP endpoints directly (for API assertions)            | Keep backend services running                         |
| Clean up test data (FK walk + auth admin) after run         | Keep env vars, secrets, and local infra healthy       |
| Report what it observed in detail                           | Diagnose root cause from the report                   |

Failed tests are signals, not support tickets. If the `users` row doesn't appear after signup, the tool reports *"DB assertion failed after 10s"* with the failing SQL — you investigate the webhook pipeline, migration state, or whatever actually broke.

---

## Install

### Requirements

- **Node.js** ≥ 20 (Node 24 LTS recommended)
- **Postgres** reachable from your host (docker-compose with a published port is fine)
- **An auth provider** — see [docs/auth/](docs/README.md#auth-providers) for setup guides:
  - [Local / in-app auth](docs/auth/local.md) (NextAuth, custom, etc.)
  - [Clerk](docs/auth/clerk.md) (bundled adapter)
  - Auth0 / Okta / Supabase — planned

### Steps

```bash
# 1. Install the CLI
npm install -g @aivionlabs/qa

# 2. One-time browser download (~300MB)
aivion-qa install-browsers
```

That's it. `aivion-qa` is now on your PATH.

---

## Quick start

### 1. Initialize in your project

```bash
cd your-project
aivion-qa init
```

Creates:
```
your-project/
├── .aivion-qa/
│   ├── qa.config.yaml          # base URLs, auth, DB config
│   └── plans/
│       └── example.yaml         # starter plan
├── .env.example
└── .gitignore                   # patched if absent
```

### 2. Configure

Edit `.aivion-qa/qa.config.yaml`:

```yaml
baseUrls:
  app: http://localhost:3000
  api: http://localhost:8000        # optional additional URLs

# Auth — see docs/auth/ for your provider:
#   docs/auth/local.md  (in-app auth — omit this block)
#   docs/auth/clerk.md  (Clerk — uncomment below)
#
# auth:
#   provider: clerk
#   secretKeyEnv: CLERK_SECRET_KEY

db:
  connectionStringEnv: DATABASE_URL
  userTable: users                  # FK-walk root + auto cleanup anchor
  userEmailColumn: email
  # cleanupExcludeTables:           # optional — tables to skip during cleanup
  #   - audit_logs

ai:
  mode: off                          # default — no LLM
  # mode: claude_cli                 # enable for ai_check + end-of-run summary
```

Create `.env` from `.env.example` and add your provider-specific secrets (see the relevant auth guide).

### 3. Verify

```bash
aivion-qa doctor
```

Example output:
```
[✓] app: http://localhost:3000 (404)
[✓] api: http://localhost:8000 (200)
[✓] database: connected (SELECT 1)
[✓] clerk: API key valid              # or skipped if you don't use Clerk
[✓] playwright chromium: installed
```

If something's red, the message tells you how to fix it.

### 4. Analyze the schema (one-time, cached)

```bash
aivion-qa learn
```

Walks `information_schema`, builds a FK graph, writes `.aivion-qa/schema.json`. This is what enables schema-aware asserts and auto cleanup. Re-run when your schema changes.

### 5. Author your first plan

The shape of `base.yaml` depends on your auth provider. Follow the guide for yours:

- **[docs/auth/local.md](docs/auth/local.md)** — in-app auth (NextAuth, custom, etc.)
- **[docs/auth/clerk.md](docs/auth/clerk.md)** — Clerk

Minimal non-provider-specific plan skeleton (drop in `.aivion-qa/plans/smoke.yaml`):

```yaml
meta:
  plan: smoke
  testUser:
    email: "qa+{run_id}@example.test"
    password: "QaTool-{run_id}-Run!"
  environments:
    app: http://localhost:3000

cases:
  - id: "1.1"
    title: Authenticated user lands on home
    actions:
      - browser.goto: /
    asserts:
      - type: expect_url
        pattern: /
      - type: user_has_row_in
        table: users
```

The `setup` + `teardown` (sign-in, user create/delete) go in `base.yaml` and are inherited — see the auth guides for the right shape.

### 6. Run

```bash
aivion-qa run smoke --headed
```

Report lands in `.aivion-qa/reports/<timestamp>_smoke/report.md`.

---

## How it works

### Five phases, per run

```
1. Pre-run cleanup    FK-walk delete of any stale test-user data
2. Create test user   via auth provider admin API (if configured) OR via your /signup UI
3. Sign in            Mode-dependent: ticket (provider) | ui | none | custom signInFlow
4. Run cases          Execute actions + asserts per case
5. Teardown           FK-walk delete + auth cleanup (runs even on failure)
```

### The `{run_id}` marker

Every run gets a unique `run_id` injected into the test email and password:

```yaml
testUser:
  email: "qa+{run_id}@example.test"       # unique every run
  password: "QaTool-{run_id}-Run!"         # unique every run
```

- **Email uniqueness** — avoids "user already exists" collisions on reruns, allows parallel runs.
- **Password uniqueness** — some providers (e.g. Clerk) run HIBP breach checks on every login and reject static common passwords.

Provider-specific email formats (e.g. Clerk's `+clerk_test` subaddress) are documented in [docs/auth/](docs/README.md#auth-providers).

### Section hierarchy

Case IDs are `<section>.<case>` (e.g. `1.1`, `3.4`). The runner uses the section prefix for hierarchy:

- **First section fails → whole run aborts.** Downstream is meaningless if signup/onboarding didn't work.
- **Later section fails → rest of THAT section is skipped**, next section starts fresh.
- `--fail-fast` overrides with immediate stop on any failure.

### FK-graph auto cleanup

When `cleanupUserData: true` is set, the runner:
1. Finds the test user row by `config.db.userEmailColumn` in `config.db.userTable`.
2. Walks every table transitively referencing `userTable` via FKs.
3. Generates `DELETE` statements in leaf-first order (FK-safe).
4. Executes them with `$1 = email`. Failures log but don't abort the sequence.

No teardown SQL to write. Add tables to `cleanupExcludeTables` if you want to preserve anything (e.g. `audit_logs`).

### Schema-aware asserts

Instead of raw SQL, use vocabulary that the tool compiles from the FK graph:

```yaml
asserts:
  - type: user_has_row_in
    table: companies                      # auto-generates SQL via FK path

  - type: user_related_field
    table: sites
    field: plan_type
    value: individual

  - type: user_row_count_in
    table: canvases
    count: 1
```

No SQL, no params, no joins to worry about. `db` / `db_eventually` with raw SQL are still there as an escape hatch.

---

## Project layout

Everything qa-tool-related lives in `.aivion-qa/`:

```
your-project/
├── .env                              # secrets (git-ignored)
├── .env.example
├── .gitignore                         # with qa-tools entries
└── .aivion-qa/
    ├── qa.config.yaml                 # committed — tool config
    ├── schema.json                    # git-ignored — FK graph cache
    ├── plans/
    │   ├── base.yaml                  # committed — shared fixture
    │   └── <your-plans>.yaml          # committed — one per flow
    └── reports/                       # git-ignored — per-run artifacts
        └── 2026-04-18_14-02_smoke/
            ├── report.md
            ├── screenshots/
            └── trace.zip
```

Gitignore template (auto-added by `aivion-qa init`):
```gitignore
# qa-tools
.aivion-qa/schema.json
.aivion-qa/profile.json
.aivion-qa/compiled/
.aivion-qa/reports/
```

Authored plans (`.aivion-qa/plans/*.yaml`) stay tracked.

---

## CLI reference

```bash
aivion-qa init                    # scaffold .aivion-qa/, .env.example, gitignore
aivion-qa doctor                  # verify URLs, DB, auth provider, chromium
aivion-qa install-browsers        # one-time Playwright chromium download
aivion-qa learn                   # analyze DB schema → .aivion-qa/schema.json
aivion-qa validate <plan>         # Zod-check a plan without running
aivion-qa run <plan>              # run one plan (headless)
aivion-qa run <plan> --headed     # show the browser
aivion-qa run <plan> --fail-fast  # stop at first failure
aivion-qa run --all               # every plan in .aivion-qa/plans/
aivion-qa report [path]           # print latest (or specific) report
```

Exit code: `0` = all pass (expected-fails excluded), `1` = any real failure.

---

## Plan YAML reference

### File skeleton

```yaml
meta:
  plan: <short-name>
  testUser:
    email: "<prefix>+{run_id}@<domain>"           # provider-specific format — see docs/auth/
    password: "QaTool-{run_id}-Run!"
  environments:
    app: http://localhost:3000
    api: http://localhost:8000                    # optional additional URLs

cases:
  - id: "1.1"
    title: "..."
    actions: [...]
    asserts: [...]

# OR, to group cases by URL:
groups:
  - url: /admin
    cases: [...]
  - url: /dashboard
    cases: [...]
```

The URL in `groups[].url` becomes an implicit `browser.goto` prepended to every case's actions. Supports templates: `/w/{{context.site_id}}`.

### Cases

Every case needs `id` and `title`. Optional: `actions[]`, `asserts[]`, `expectedFail`.

```yaml
- id: "3.1"
  title: Create diagram — editor opens, capture id
  actions:
    - browser.click: "+ New Diagram"
    - browser.capture_url:
        pattern: "/canvas-v2/edit/([^/?#]+)"
        as: context.diagram_id
  asserts:
    - type: expect_url
      pattern: /canvas-v2/edit/
    - type: user_has_row_in
      table: canvases
```

`expectedFail: { bug: "BUG-011" }` marks a case as a known-failing bug; its failure doesn't red the run.

### Actions

| Verb | Shape | What it does |
|---|---|---|
| `browser.goto` | string | Navigate. Relative paths resolve against `environments.app`. |
| `browser.click` | string | Click. CSS selector (starts with `[`, `.`, `#`, or `tag[`) OR exact visible text. |
| `browser.fill` | `{ selector, value }` | Fill an input. |
| `browser.fill_form` | `{ from: test_user }` | Auto-fill email + password. Tries Clerk (`identifier`, `emailAddress`) and generic selectors. |
| `browser.submit` | `true` | Click first `button[type=submit]`, else press Enter. |
| `browser.wait_for` | string | Wait up to 15s for a selector. |
| `browser.capture_url` | `{ pattern, as }` | Regex against `page.url()`; store group into context. |
| `http.post` | `{ url, auth?, body? }` | Direct POST. `auth: session` forwards browser cookies. |
| `http.get` | `{ url, auth? }` | Direct GET. |

### Asserts

All asserts have a `type` discriminator.

**URL / text / DOM (pure Playwright):**

| Type | Shape |
|---|---|
| `expect_url` | `{ pattern }` — substring if starts with `/`, else regex |
| `expect_text` | `{ text, selector? }` |
| `expect_visible` | `{ text?, selector? }` |
| `expect_not_visible` | same |
| `expect_disabled` | `{ selector }` |
| `expect_attribute` | `{ selector, attr, value? \| pattern? }` |
| `expect_download` | `{ filename_pattern? }` — arm BEFORE the triggering action |
| `expect_modal` | `{ kind }` — data-testid / class / aria-label / text contains kind |

**Network:**

| Type | Shape |
|---|---|
| `no_network_call_matching` | `{ pattern, windowMs? }` — installed before case actions, fails if any request matches |

**HTTP status (pair with a preceding `http.*` action):**

| Type | Shape |
|---|---|
| `http_status` | `{ expect: 402 }` |

**DB — schema-aware (no SQL in plans):**

| Type | Shape |
|---|---|
| `user_has_row_in` | `{ table }` |
| `user_row_count_in` | `{ table, count }` |
| `user_field_equals` | `{ field, value }` |
| `user_related_field` | `{ table, field, value }` |
| `user_related_count` | `{ table, count }` |

**DB — raw SQL (escape hatch):**

| Type | Shape |
|---|---|
| `db` | `{ sql, params, expect, storeAs? }` — `expect`: `"non_empty"` / `"empty"` / string / number |
| `db_eventually` | `{ sql, params, expect, timeoutMs, storeAs? }` — polls until match or timeout |

**AI-evaluated (only if `ai.mode` ≠ `off`):**

| Type | Shape |
|---|---|
| `ai_check` | `{ assertion, includeScreenshot? }` — natural-language claim → `{ pass, reason }` |

### Carrying state between cases

Use `storeAs` on a DB assert to stash a value:

```yaml
- type: db_eventually
  sql: "SELECT id FROM users WHERE email = $1"
  params: ["{{meta.test_user.email}}"]
  expect: non_empty
  storeAs: context.user_id                  # stash
```

Then reference `{{context.user_id}}` anywhere. Combined with `browser.capture_url`, you can thread IDs/slugs from URLs AND DB rows through the plan.

### Template references

Any string value. Resolved at run time.

| Reference | Value |
|---|---|
| `{{meta.test_user.email}}` | Test email (with `{run_id}` substituted) |
| `{{meta.test_user.password}}` | Password |
| `{{meta.environments.<name>}}` | Named environment URL |
| `{{context.<key>}}` | Value stashed via `storeAs` or `browser.capture_url` |
| `{run_id}` | Single braces — **only** in `meta.test_user.email` / `.password`. Different substitution pass. |

Snake_case and camelCase both work (`meta.test_user` == `meta.testUser`).

### `setup` and `teardown`

Typically defined once in `.aivion-qa/plans/base.yaml` and inherited. Plan values override scalars; arrays concatenate (base first).

**setup keys:**

| Field | Purpose |
|---|---|
| `cleanupUserData: true` | FK-walk delete stale test-user data before any case |
| `auth.createUser` | Create user via auth provider admin API |
| `seedSql: [...]` | Raw SQL after createUser |
| `signIn` | `ticket` (default) \| `ui` \| `none` |
| `signInFlow: [actions]` | Custom sign-in action sequence (overrides `signIn`) |

**teardown keys:**

| Field | Purpose |
|---|---|
| `cleanupUserData: true` | FK-walk delete after last case |
| `sql: [{ sql, params }]` | Additional teardown statements |
| `auth.cleanupUser: email` | Delete the auth-provider user |

### Sign-in modes

| Mode | What it does | When to use |
|---|---|---|
| `signIn: ticket` | Provider-specific programmatic sign-in (e.g. Clerk's sign-in token). Bypasses any UI challenges. | Default when your provider supports it. |
| `signIn: ui` | Drives `/login` with a generic email+password form. | Simple single-step forms only. |
| `signIn: none` | No auto-login. | The plan's first case handles sign-in itself. |
| `signInFlow: [actions]` | Custom multi-step sign-in. | Multi-step flows, in-app auth, or testing the sign-in UI itself. |

The runner verifies the browser has left any sign-in URL within 15s of the flow finishing; otherwise aborts.

**Provider-specific examples** are in the auth guides — see [docs/auth/](docs/README.md#auth-providers).

---

## Configuration reference

### `.aivion-qa/qa.config.yaml`

```yaml
baseUrls:
  app: http://localhost:3000
  api: http://localhost:8000        # any number of named URLs

# Auth — provider-specific; see docs/auth/:
#   Omit this block entirely for local in-app auth.
# auth:
#   provider: clerk
#   secretKeyEnv: CLERK_SECRET_KEY

db:
  connectionStringEnv: DATABASE_URL
  userTable: users                   # FK anchor + auto cleanup root
  userEmailColumn: email
  cleanupExcludeTables:               # optional
    - audit_logs
    - billing_events

ai:
  mode: off                           # off | claude_cli | sdk
  # model: sonnet                     # claude_cli only

  # mode: sdk
  # sdk:
  #   provider: anthropic
  #   model: claude-sonnet-4-6
  #   apiKeyEnv: ANTHROPIC_API_KEY

  # tasks:                            # per-task overrides
  #   ai_check: { model: sonnet }
  #   summary:  { model: haiku }
```

### `.env`

```env
DATABASE_URL=postgresql://user:pass@localhost:5432/your_db
# Provider-specific secrets — see docs/auth/ for what your provider needs:
# CLERK_SECRET_KEY=sk_test_...
# ANTHROPIC_API_KEY=sk-ant-...       # only if ai.mode = sdk with anthropic
```

---

## Troubleshooting

### `aivion-qa doctor` reports `playwright chromium: not installed`

```bash
aivion-qa install-browsers
```

### `ENOTFOUND postgres` in `aivion-qa learn`

Your `DATABASE_URL` uses a Docker service name like `postgres` — not resolvable from the host. Use `localhost:5432` (with port published in docker-compose):
```env
DATABASE_URL=postgresql://user:pass@localhost:5432/your_db
```

### `locator.click: Timeout 10000ms exceeded`

The selector didn't match. Run with `--headed`, open devtools, confirm the actual selector. For text-based clicks, the target must be EXACT (no "Continue" matching "Sign in with Google Continue").

### `expected ... got ...` on `user_has_row_in` or similar

Either the FK path the tool found is wrong (rare — double-check your schema), or the app genuinely didn't create the row. Inspect `.aivion-qa/schema.json` to see the FK graph, or drop back to a raw `db_eventually` with explicit SQL.

### `Template reference {{...}} is not resolved`

Either the reference path is wrong, or the case that should have populated it didn't run. Check the log — `context.<key>` only populates after a prior assert ran `storeAs: context.<key>`.

### Provider-specific issues

See the auth guide for your provider:
- [docs/auth/local.md](docs/auth/local.md) — in-app auth
- [docs/auth/clerk.md](docs/auth/clerk.md) — Clerk (HIBP, test mode, 2FA, sign-in ticket)

---

## Data privacy

`aivion-qa` is a local CLI. It collects **no telemetry**, has **no analytics**, and makes **no outbound calls** beyond what you explicitly configure.

| Surface                          | Where data goes                                                          |
| -------------------------------- | ------------------------------------------------------------------------ |
| Default (`ai.mode: off`)         | Zero data leaves your machine.                                           |
| `ai.mode: claude_cli`            | Prompts pass through your local Claude Code install — per its own terms. |
| `ai.mode: sdk`                   | Prompts (DOM snippets, screenshots) go to the provider you configure.    |
| Auth provider API calls          | Test-user create/delete — direct from your host to the provider with your key. |
| Database queries                 | Direct from your host to your DB.                                        |
| Reports                          | Written to `.aivion-qa/reports/` on your disk. Nothing uploaded.         |

**Nothing is ever sent to Aivion Labs.** We have no servers, no database, no pipeline, no analytics. `aivion-qa` is free open source software distributed under the MIT license with no paid version, no hosted offering, and no commercial support. Aivion Labs receives no revenue, donations, or personal data from this tool.

### GDPR

Aivion Labs processes no personal data through this tool. When you run `aivion-qa`, you are the sole data controller for any data that flows through it on your machine. If you enable `ai.mode: sdk` with a third-party LLM provider (Anthropic, OpenAI, etc.), DOM snippets from the app under test may include personal data — in that case the LLM provider is your processor, under whatever DPA you've agreed with them.

### Cleanup safety

`DELETE FROM` statements in auto cleanup are scoped by FK-walk from the test user (found by email) — no blind deletion. Use `cleanupExcludeTables` in `qa.config.yaml` to protect critical tables (e.g. `audit_logs`) from the walk.

---

## Contributing

This is a two-person project right now. If you find a bug:

1. Reproduce with `aivion-qa run <plan> --headed`
2. Capture the `.aivion-qa/reports/<timestamp>/` directory (has `report.md` + `trace.zip`)
3. Open an issue at https://github.com/aivionlabs/aivion-qa/issues with that + your `.aivion-qa/qa.config.yaml` (with secrets redacted)

---

## License

MIT © Aivion Labs
