# Plan YAML reference

Full spec for `.aivion-qa/plans/<name>.yaml`. Deterministic: what you write is exactly what runs.

## File skeleton

```yaml
meta:
  plan: <short-name>
  testUser:
    email: "<prefix>+{run_id}@<domain>"       # provider-specific format — see docs/auth/
    password: "QaTool-{run_id}-Run!"
  environments:
    app: http://localhost:3000
    api: http://localhost:8000                 # optional additional URLs

cases:                                         # flat list
  - id: "1.1"
    title: "..."
    actions: [...]
    asserts: [...]

# OR group cases by URL:
groups:
  - url: /admin
    cases: [...]
  - url: /dashboard
    cases: [...]
```

The URL in `groups[].url` becomes an implicit `browser.goto` prepended to every case's actions. Supports templates: `/w/{{context.site_id}}`.

## `meta`

| Field | Notes |
|---|---|
| `plan` | short name used in report filenames |
| `testUser.email` | must include `{run_id}` for per-run uniqueness; provider may require specific format |
| `testUser.password` | include `{run_id}` — avoids breach-list rejections on login |
| `environments.app` | base URL of the app |
| `environments.<name>` | any additional URLs — reference as `{{meta.environments.<name>}}` |

## Cases

Every case needs `id` and `title`. Optional: `actions`, `asserts`, `expectedFail`.

```yaml
- id: "3.1"
  title: Create diagram
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

### Section hierarchy

Case IDs are `<section>.<case>` (e.g. `1.1`, `3.4`).

- First section fails → whole run aborts.
- Later section fails → rest of THAT section is skipped; next section runs fresh.
- `--fail-fast` overrides — stops on any failure.

## Actions

| Verb | Shape | What it does |
|---|---|---|
| `browser.goto` | string | Navigate. Relative paths resolve against `environments.app`. |
| `browser.click` | string | Click. CSS selector (starts with `[`, `.`, `#`, or `tag[`) OR exact visible text. |
| `browser.fill` | `{ selector, value }` | Fill an input. |
| `browser.fill_form` | `{ from: test_user }` | Auto-fill email + password. Tries common selectors (Clerk `identifier`/`emailAddress` + generic `email`/`#email`). |
| `browser.submit` | `true` | Click first `button[type=submit]`, else press Enter. |
| `browser.wait_for` | string | Wait up to 15s for a selector. |
| `browser.press_key` | string | Press one or more keys. Playwright key syntax: `"Enter"`, `"Escape"`, `"Control+Shift+P"`, `"Meta+K"`. |
| `browser.drag_to` | `{ from, to }` | Drag from one selector to another. Both must be visible + actionable. |
| `browser.capture_url` | `{ pattern, as }` | Regex against `page.url()`; store capture group into context. |
| `http.post` | `{ url, auth?, body? }` | Direct POST. `auth: session` forwards browser cookies. |
| `http.get` | `{ url, auth? }` | Direct GET. |

HTTP status of the most recent `http.*` action is stashed for the next `http_status` assert in the same case.

## Asserts

All have a `type` discriminator.

### URL / text / DOM (pure Playwright)

| Type | Shape |
|---|---|
| `expect_url` | `{ pattern }` — substring if starts with `/`, else regex |
| `expect_text` | `{ text, selector? }` |
| `expect_visible` | `{ text?, selector? }` |
| `expect_not_visible` | same |
| `expect_disabled` | `{ selector }` |
| `expect_attribute` | `{ selector, attr, value? \| pattern? }` |
| `expect_download` | `{ filename_pattern? }` — arm BEFORE the triggering action |
| `expect_modal` | `{ kind }` — matches element by `data-testid`/class/`aria-label`/text containing kind |

### Network

| Type | Shape |
|---|---|
| `no_network_call_matching` | `{ pattern, windowMs? }` — installed before case actions; fails if any request matches |

### HTTP status

| Type | Shape |
|---|---|
| `http_status` | `{ expect }` — pair with a preceding `http.*` action |

### DB — schema-aware (no SQL in plans)

Uses `config.db.userTable` + `.aivion-qa/schema.json` FK graph.

| Type | Shape |
|---|---|
| `user_has_row_in` | `{ table }` |
| `user_row_count_in` | `{ table, count }` |
| `user_field_equals` | `{ field, value }` |
| `user_related_field` | `{ table, field, value }` |
| `user_related_count` | `{ table, count }` |

### DB — raw SQL (escape hatch)

| Type | Shape |
|---|---|
| `db` | `{ sql, params, expect, storeAs? }` — `expect`: `"non_empty"` / `"empty"` / string / number |
| `db_eventually` | `{ sql, params, expect, timeoutMs, storeAs? }` — polls until match or timeout |

### AI-evaluated (only if `ai.mode` ≠ `off`)

| Type | Shape |
|---|---|
| `ai_check` | `{ assertion, includeScreenshot? }` — natural-language claim → `{ pass, reason }` |

## Carrying state — `storeAs`

Use `storeAs` on a DB assert to stash a value, reference later:

```yaml
- type: db_eventually
  sql: "SELECT id FROM users WHERE email = $1"
  params: ["{{meta.test_user.email}}"]
  expect: non_empty
  storeAs: context.user_id
```

Then `{{context.user_id}}` anywhere. Combined with `browser.capture_url`, you thread IDs/slugs from URLs + DB rows through the plan.

## Template references

Any string value. Resolved at run time. Snake_case and camelCase both work.

| Reference | Value |
|---|---|
| `{{meta.test_user.email}}` | test email (with `{run_id}` substituted) |
| `{{meta.test_user.password}}` | password |
| `{{meta.environments.<name>}}` | named environment URL |
| `{{context.<key>}}` | value stashed via `storeAs` or `browser.capture_url` |
| `{run_id}` | single braces — **only** in `meta.test_user.email` / `.password`; different substitution pass |

## `base.yaml` — shared fixture

Drop `.aivion-qa/plans/base.yaml` once. Every plan in the dir auto-inherits it. Plan values override scalars; arrays concatenate (base first).

### `setup` keys

| Field | Purpose |
|---|---|
| `cleanupUserData: true` | FK-walk delete of stale test-user data before any case |
| `auth.createUser` | Create user via auth provider admin API (provider-specific) |
| `seedSql: [...]` | Raw SQL statements after createUser |
| `signIn` | `ticket` \| `ui` \| `none` — see sign-in modes below |
| `signInFlow: [actions]` | Custom sign-in action sequence (overrides `signIn`) |

### `teardown` keys

| Field | Purpose |
|---|---|
| `cleanupUserData: true` | FK-walk delete after last case |
| `sql: [{ sql, params }]` | Additional teardown statements |
| `auth.cleanupUser: email` | Delete the auth-provider user |

## Sign-in modes

| Mode | What it does | When to use |
|---|---|---|
| `signIn: ticket` | Provider-specific programmatic sign-in | Default when your provider supports it |
| `signIn: ui` | Drives `/login` with a generic email+password form | Simple single-step forms only |
| `signIn: none` | No auto-login | The plan's first case handles sign-in itself |
| `signInFlow: [actions]` | Custom multi-step sign-in | Multi-step flows or in-app auth |

The runner verifies the browser has left any sign-in URL within 15s; otherwise aborts with a clear error.

**Provider-specific sign-in examples** live in [docs/auth/](README.md#auth-providers).

## Minimal working example

```yaml
# .aivion-qa/plans/base.yaml (provider-specific — see docs/auth/)
setup:
  cleanupUserData: true
teardown:
  cleanupUserData: true
```

```yaml
# .aivion-qa/plans/smoke.yaml
meta:
  plan: smoke
  testUser:
    email: "qa+{run_id}@example.test"
    password: "QaTool-{run_id}-Run!"
  environments:
    app: http://localhost:3000

cases:
  - id: "1.1"
    title: Authenticated home loads
    actions:
      - browser.goto: /
    asserts:
      - type: expect_url
        pattern: /
      - type: user_has_row_in
        table: users
```

```bash
aivion-qa validate smoke
aivion-qa run smoke --headed
```
