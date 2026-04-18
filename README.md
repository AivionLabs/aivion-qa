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

- **Local-first.** Runs on your machine against your stack. Reports stay on disk.
- **YAML-only plans.** No DSL, no compile step, no LLM cost for reading plans.
- **Zero LLM by default.** Playwright + SQL + Zod. LLM is opt-in for fuzzy assertions.
- **Observe, don't orchestrate.** Tests what you have running — doesn't start your app, configure your auth, or run migrations.
- **Zero telemetry.** No analytics, no phone-home. See [Data privacy](#data-privacy).

## What it does

Drives a real browser against your locally-running app. Runs typed asserts (URL, DOM, network, HTTP status) and schema-aware DB asserts (auto-generated SQL from your FK graph). Creates + destroys test users per run via your auth provider's admin API. Writes a markdown report with screenshots and a Playwright trace.

Full responsibility split: [docs/README.md](docs/README.md).

---

## Install

**Requirements**
- Node.js ≥ 20 (Node 24 LTS recommended)
- Postgres reachable from your host (docker-compose with a published port is fine)
- An auth provider — see [docs/auth/](docs/README.md#auth-providers)

```bash
npm install -g @aivionlabs/qa
aivion-qa install-browsers        # one-time ~300MB Chromium download
```

## Quick start

```bash
cd your-project
aivion-qa init                    # scaffolds .aivion-qa/
```

Configure `.aivion-qa/qa.config.yaml` (baseUrls, db) and `.env` (`DATABASE_URL` + any provider keys). Wire auth using one of:

- **[docs/auth/local.md](docs/auth/local.md)** — in-app auth (NextAuth, custom JWT, etc.)
- **[docs/auth/clerk.md](docs/auth/clerk.md)** — Clerk (bundled adapter)

Then:

```bash
aivion-qa doctor                  # verify connectivity
aivion-qa learn                   # analyze DB schema (one-time, cached)
aivion-qa run smoke --headed      # run your plan
```

Reports land in `.aivion-qa/reports/<timestamp>_<plan>/`.

---

## How it works (briefly)

```
Phase 0  LEARN      FK graph cache (.aivion-qa/schema.json)
Phase 1  PREPARE    cleanup → create user (optional) → sign in
Phase 2  EXECUTE    cases with hierarchy (first section abort; section fail-fast)
Phase 3  TEARDOWN   FK-walk delete + auth cleanup
```

- Every run gets a unique `{run_id}` injected into the test email + password (avoids collisions + breach-list rejections).
- `setup.cleanupUserData: true` walks the FK graph from `config.db.userTable` and deletes every row tied to the test user — no hand-written teardown SQL.
- Schema-aware asserts (`user_has_row_in`, `user_related_field`, etc.) auto-generate SQL from the FK graph. Raw `db` / `db_eventually` remain as escape hatches.

Full reference: [docs/plan-reference.md](docs/plan-reference.md).

---

## Commands

```bash
aivion-qa init                    # scaffold .aivion-qa/
aivion-qa doctor                  # verify URLs, DB, auth provider, chromium
aivion-qa install-browsers        # one-time Playwright chromium download
aivion-qa learn                   # analyze DB schema → .aivion-qa/schema.json
aivion-qa validate <plan>         # Zod-check a plan without running
aivion-qa run <plan> [--headed] [--fail-fast]
aivion-qa run --all               # every plan in .aivion-qa/plans/
aivion-qa report [path]           # print latest (or specific) report
```

Exit code: `0` all-pass (expected-fail excluded), `1` any real failure.

---

## Project layout

```
your-project/
├── .env                           # secrets (git-ignored)
└── .aivion-qa/
    ├── qa.config.yaml             # tool config (committed)
    ├── schema.json                # FK graph cache (git-ignored)
    ├── plans/
    │   ├── base.yaml              # shared fixture (committed)
    │   └── <your-plan>.yaml       # committed
    └── reports/                    # per-run artifacts (git-ignored)
```

Gitignore additions (added automatically by `aivion-qa init`):
```
.aivion-qa/schema.json
.aivion-qa/compiled/
.aivion-qa/reports/
```

---

## Documentation

- **[Plan YAML reference](docs/plan-reference.md)** — full spec (meta, cases, actions, asserts, templates, groups, base.yaml, sign-in modes)
- **[Auth providers](docs/README.md#auth-providers)** — local, Clerk, future (Auth0, Okta, Supabase)
- **[Troubleshooting](docs/troubleshooting.md)** — common errors and fixes

---

## Data privacy

`aivion-qa` is a local CLI. **No telemetry, no analytics, no outbound calls** beyond what you configure.

| Surface | Where data goes |
|---|---|
| Default (`ai.mode: off`) | Nothing leaves your machine |
| `ai.mode: claude_cli` | Prompts through your local Claude Code install, per its terms |
| `ai.mode: sdk` | Prompts (DOM, screenshots) to the provider you configure |
| Auth provider API calls | Test-user create/delete — direct from your host to the provider |
| Database queries | Direct from your host to your DB |
| Reports | `.aivion-qa/reports/` on your disk — nothing uploaded |

**Nothing is ever sent to Aivion Labs.** No servers, no database, no pipeline, no analytics. `aivion-qa` is free open source software distributed under MIT with no paid version, no hosted offering, no commercial support.

**GDPR:** Aivion Labs processes no personal data via this tool. You are the sole data controller for any data that flows through it on your machine.

---

## License

MIT © Aivion Labs. See [LICENSE](LICENSE).

## Security

Found a vulnerability? See [SECURITY.md](SECURITY.md).

## Contributing

Bug reports: https://github.com/AivionLabs/aivion-qa/issues
Security: `security@aivionlabs.com`
