# Auth setup — Local / in-app auth

Use this guide if your app rolls its own login (NextAuth, custom JWT, Lucia, Better Auth, session table, etc.) and you don't use a third-party auth provider.

## Summary

For local auth, there's **nothing to configure in `qa.config.yaml`** — omit the `auth` block entirely. Your plan drives sign-in / sign-up through your own UI using `setup.signInFlow`. Teardown cleans up via the FK-walk cleanup (which doesn't need an auth adapter).

## Step 1 — `qa.config.yaml`

```yaml
baseUrls:
  app: http://localhost:3000

# NO auth: block — local auth doesn't need an adapter

db:
  connectionStringEnv: DATABASE_URL
  userTable: users                 # the table where sign-up writes new users
  userEmailColumn: email

ai:
  mode: off
```

## Step 2 — test user

Unlike external-provider flows, **you create the test user via your own sign-up UI** in each run. Append `{run_id}` to the email so every run gets a unique user:

```yaml
# .aivion-qa/plans/<your-plan>.yaml
meta:
  plan: my-plan
  testUser:
    email: "qa+{run_id}@example.test"
    password: "QaTool-{run_id}-Run!"        # {run_id} avoids any breach-list collisions
  environments:
    app: http://localhost:3000
```

## Step 3 — `base.yaml` — cleanup + sign-up flow

```yaml
# .aivion-qa/plans/base.yaml
setup:
  cleanupUserData: true           # FK-walk delete of any stale rows for this email
  signInFlow:
    # This is your SIGN-UP flow (because we're running a fresh email every time).
    - browser.goto: /signup
    - browser.fill:
        selector: 'input[name="email"]'
        value: "{{meta.test_user.email}}"
    - browser.fill:
        selector: 'input[name="password"]'
        value: "{{meta.test_user.password}}"
    - browser.click: "Sign up"
    # Wait for redirect to authenticated area
    - browser.wait_for: '[data-testid="nav-user-menu"]'

teardown:
  cleanupUserData: true           # FK-walk delete at exit
  # no auth.cleanupUser — local auth has no third-party account to delete
```

### Why this pattern works

1. **Pre-run cleanup** (`cleanupUserData: true`) deletes any rows for the test email left over from a crashed previous run. Idempotent.
2. **Sign-up drives your real flow.** Any logic behind `/signup` (password hashing, welcome emails, tenant creation) gets exercised.
3. **Session is established** by your app's sign-up flow — session cookie / JWT / whatever — and persists for all subsequent cases.
4. **Post-run cleanup** does another FK-walk.

## Step 4 — testing *login* (not sign-up)

If you also want to verify the login flow separately, write a second plan whose `signInFlow` drives `/login` with pre-existing credentials:

```yaml
# .aivion-qa/plans/login-flow.yaml
meta:
  plan: login-flow
  testUser:
    email: "pre-existing@example.test"   # no {run_id} — this user exists in your seed data
    password: "SeedPassword123"
  environments:
    app: http://localhost:3000

# Override base.yaml's signInFlow for this plan
setup:
  cleanupUserData: false          # don't nuke the seeded user
  signInFlow:
    - browser.goto: /login
    - browser.fill: { selector: 'input[name="email"]', value: "{{meta.test_user.email}}" }
    - browser.fill: { selector: 'input[name="password"]', value: "{{meta.test_user.password}}" }
    - browser.click: "Sign in"
    - browser.wait_for: '[data-testid="nav-user-menu"]'

teardown:
  cleanupUserData: false

cases:
  - id: "1.1"
    title: Home shows user menu
    actions:
      - browser.goto: /
    asserts:
      - type: expect_visible
        selector: '[data-testid="nav-user-menu"]'
```

## Step 5 — password storage in your app

If your app hashes passwords (bcrypt/argon2/scrypt), the test user's plaintext password from `meta.testUser.password` is what you send to `/signup` — your app hashes it as usual. `aivion-qa` stores nothing.

If your app has a **rate limiter** on `/login` or `/signup`, make sure it allows test traffic from `localhost` — either by IP allowlist or by skipping rate limits in dev.

## Known limitations

- **No programmatic sign-in.** Every run does a real UI sign-up (or sign-in) — ~2-3s extra per run. Not bad for a handful of runs; expensive for large suites.
- **No session reuse across plans.** Each run starts fresh. Fine for isolation; means re-signup every plan.
- **No admin-API user management.** Cleanup is DB-only (`cleanupUserData`); we can't "delete the auth account" because there isn't one separate from the DB row.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `signInFlow` times out waiting for `wait_for` selector | Your sign-up redirect takes longer than 15s, or the selector is wrong | Use `--headed` and confirm the actual DOM state post-signup |
| Test user persists after run | `cleanupUserData: false`, OR the FK path from `users` doesn't catch related rows | Check `.aivion-qa/schema.json` for FK edges, or add a manual `teardown.sql` entry |
| Sign-up form rejects the test email | Email-format validation, domain blocklist, or CAPTCHA | Use a format your validator accepts; exempt CAPTCHA in dev |
| Rate limiter blocks after a few runs | Running many runs fast | Whitelist localhost, or add `app.rateLimitBypass: true` in dev env |

## Mixing with external auth later

If you migrate to Clerk / Auth0 / etc., swap in the appropriate auth block + adapter config. Plans can keep their existing `signInFlow` as-is, OR drop it for the provider's `signIn: ticket` mode (where supported) for faster runs.
