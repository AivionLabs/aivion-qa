# Auth setup — Clerk

Use this guide if your app uses [Clerk](https://clerk.com) for authentication. The bundled Clerk adapter handles user create/delete via Backend API and programmatic sign-in via Clerk's sign-in token flow.

## Summary

1. Enable **Test mode** on your Clerk instance (Dashboard → Settings → Testing).
2. Add `CLERK_SECRET_KEY` to `.env`.
3. Point `auth` in `qa.config.yaml` at Clerk.
4. Use `setup.signIn: ticket` in `base.yaml` to bypass the login UI entirely.

Sign-in takes <1s per run. Completely bypasses breach checks, 2FA, device verification, captcha, and bot detection.

## Step 1 — Clerk instance prerequisites

In [Clerk Dashboard](https://dashboard.clerk.com):

- **Settings → Testing → Test mode: ON**
- This unlocks:
  - The `+clerk_test` email subaddress (bypasses real email verification — see below)
  - Testing tokens (bypass bot detection)
  - Fixed test verification code `424242`
- Copy your **Secret key** from Settings → API Keys

## Step 2 — `qa.config.yaml`

```yaml
baseUrls:
  app: http://localhost:3000

auth:
  provider: clerk
  secretKeyEnv: CLERK_SECRET_KEY    # env var name, NOT the value

db:
  connectionStringEnv: DATABASE_URL
  userTable: users                   # the table where your Clerk webhook syncs users
  userEmailColumn: email

ai:
  mode: off
```

## Step 3 — `.env`

```env
CLERK_SECRET_KEY=sk_test_...
DATABASE_URL=postgresql://user:pass@localhost:5432/your_db
```

## Step 4 — test user format

Use the `+clerk_test` subaddress — it's Clerk's test-mode marker that bypasses real email verification — and include `{run_id}` for uniqueness:

```yaml
# .aivion-qa/plans/<your-plan>.yaml
meta:
  plan: my-plan
  testUser:
    email: "team+clerk_test+{run_id}@aivionlabs.com"
    password: "QaTool-{run_id}-Run!"
  environments:
    app: http://localhost:3000
```

**Why `{run_id}` in the password:** Clerk's frontend runs HIBP (breach database) checks on every login. Static strings like `TestPassword123!` are on HIBP and get rejected at sign-in. Appending `{run_id}` guarantees uniqueness.

## Step 5 — `base.yaml` — programmatic sign-in via ticket

```yaml
# .aivion-qa/plans/base.yaml
setup:
  cleanupUserData: true
  auth:
    createUser:                     # create the user via Clerk Backend API
      email: "{{meta.test_user.email}}"
      via: clerk
  signIn: ticket                     # programmatic sign-in — fastest, bypasses all UI challenges

teardown:
  cleanupUserData: true
  auth:
    cleanupUser: "{{meta.test_user.email}}"   # deletes the Clerk user via Backend API
```

### What happens behind the scenes

```
1. Pre-run cleanup   FK-walk delete any stale rows for the test email
2. createUser        POST https://api.clerk.com/v1/users
                     Returns user_id, skips HIBP (via skip_password_checks)
3. signIn: ticket    POST https://api.clerk.com/v1/sign_in_tokens
                     Response includes a URL like:
                       http://localhost:3000/login?__clerk_ticket=eyJ...
                     Navigates the browser there → Clerk middleware
                     signs the user in → redirects to your app
4. Cases run         Browser is now authenticated; cookies persist
5. Teardown          FK-walk delete + DELETE /v1/users/<id>
```

## Sign-in modes

| Mode | What it does | When to use |
|---|---|---|
| `signIn: ticket` (default) | Server-minted sign-in token, bypasses all frontend challenges | **Default.** Any flow that tests authenticated app behavior. |
| `signIn: ui` | Drives a generic `/login` email+password form | Only if you have a simple single-step login. Clerk's multi-step flow will fail here. |
| `signIn: none` | No auto-login | Only if you're testing the login UI itself — your plan's first case drives login manually. |
| `signInFlow: [actions]` | Custom action sequence for login | For testing the actual Clerk login UI. Example below. |

### `signInFlow` for Clerk's two-step password login

If you want to test the real login UI (not just skip to authenticated state):

```yaml
setup:
  auth:
    createUser: { email: "{{meta.test_user.email}}", via: clerk }
  # no signIn here — signInFlow takes over
  signInFlow:
    - browser.goto: /sign-in
    - browser.fill:
        selector: 'input[name="identifier"]'
        value: "{{meta.test_user.email}}"
    - browser.click: "Continue"
    - browser.wait_for: 'input[name="password"]:visible'
    - browser.fill:
        selector: 'input[name="password"]'
        value: "{{meta.test_user.password}}"
    - browser.click: "Continue"
```

**Gotcha:** Clerk's UI shows a "device verification" step on first sign-in from any fresh browser (Playwright is always a fresh browser). If you need to test through that, add:

```yaml
    # After password → "Check your email" screen appears, one input per digit
    - browser.wait_for: 'input[name="code-0"]'
    - browser.fill: { selector: 'input[name="code-0"]', value: "4" }
    - browser.fill: { selector: 'input[name="code-1"]', value: "2" }
    - browser.fill: { selector: 'input[name="code-2"]', value: "4" }
    - browser.fill: { selector: 'input[name="code-3"]', value: "2" }
    - browser.fill: { selector: 'input[name="code-4"]', value: "4" }
    - browser.fill: { selector: 'input[name="code-5"]', value: "2" }
```

`424242` is Clerk's fixed test-mode code; real email is never sent because the `+clerk_test` subaddress routes to Clerk's internal test bucket.

### Sign-up flow (testing the signup UI)

Skip `auth.createUser` and drive `/sign-up` in your plan's first case. Teardown will find the user by email via Clerk's `findUserByEmail` + delete:

```yaml
# no setup.auth.createUser
setup:
  cleanupUserData: true
  signIn: none

teardown:
  cleanupUserData: true
  auth:
    cleanupUser: "{{meta.test_user.email}}"

cases:
  - id: "1.1"
    title: Sign up
    actions:
      - browser.goto: /sign-up
      - browser.fill: { selector: 'input[name="emailAddress"]', value: "{{meta.test_user.email}}" }
      - browser.click: "Continue"
      - browser.wait_for: 'input[name="password"]:visible'
      - browser.fill: { selector: 'input[name="password"]', value: "{{meta.test_user.password}}" }
      - browser.click: "Continue"
      # ... verification code, etc.
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Clerk createUser failed: Password has been found in an online data breach` | Static password on HIBP list | Include `{run_id}` in `meta.testUser.password` |
| `Clerk getTestingToken failed: ... CLERK_TESTING_ENABLED` | Test mode is off | Clerk Dashboard → Settings → Testing → toggle ON |
| After `signIn: ticket`, browser stays on `accounts.dev/sign-in` | Instance didn't return a valid sign-in URL, or user doesn't exist | Check `setup.auth.createUser` ran in the run log. Verify your key has admin permissions. |
| `locator.click: strict mode violation — resolved to 2 elements` clicking "Continue" | Clerk shows both a Google button and a form Continue | `browser.click` already uses exact text matching (`exact: true`). If you're still hitting this, switch to a CSS selector: `button[data-localization-key="formButtonPrimary"]` |
| Stuck on `accounts.dev/sign-in/factor-two` | 2FA or device verification challenge | Switch to `signIn: ticket` (recommended) or expand `signInFlow` with the code-input step |
| Users piling up in Clerk dashboard | Teardown failed on a previous run | Next run's `cleanupUserData` will clear the DB; Clerk users are harmless (each run uses a unique email) |

## Clerk-specific config reference

| Field | Purpose |
|---|---|
| `auth.provider: clerk` | Activates the Clerk adapter |
| `auth.secretKeyEnv: CLERK_SECRET_KEY` | Env var name holding the secret key |

## API endpoints used

For the curious / for security review. All calls originate from the developer's laptop, authenticated with the dev's own `CLERK_SECRET_KEY`:

- `POST https://api.clerk.com/v1/users` — create test user
- `POST https://api.clerk.com/v1/testing_tokens` — mint testing token (bot-detection bypass)
- `POST https://api.clerk.com/v1/sign_in_tokens` — mint sign-in token (programmatic sign-in)
- `GET  https://api.clerk.com/v1/users?email_address=<email>` — find user by email (teardown fallback)
- `DELETE https://api.clerk.com/v1/users/<id>` — delete test user
