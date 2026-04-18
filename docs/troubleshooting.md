# Troubleshooting

## `aivion-qa doctor` reports `playwright chromium: not installed`

```bash
aivion-qa install-browsers
```

## `ENOTFOUND postgres` in `aivion-qa learn`

Your `DATABASE_URL` uses a Docker service name like `postgres` — not resolvable from the host. Use `localhost:5432` (with the port published in docker-compose):

```env
DATABASE_URL=postgresql://user:pass@localhost:5432/your_db
```

## `locator.click: Timeout 10000ms exceeded`

The selector didn't match. Run with `--headed`, open devtools, confirm the actual selector. For text-based clicks the target must be EXACT — no partial matches.

## `expected ... got ...` on `user_has_row_in` or similar

Either:
- The FK path the tool found is wrong (rare — inspect `.aivion-qa/schema.json` to verify the edge), or
- The app genuinely didn't create the row.

Drop back to a raw `db_eventually` with explicit SQL if the schema-aware assert can't express what you need.

## `Template reference {{...}} is not resolved`

The reference path is wrong, or the case that should have populated it didn't run. `context.<key>` only populates after a prior assert ran `storeAs: context.<key>`.

Check the log — the first failing case will say `Context bag is empty` or list the available keys.

## Sign-in stays on a sign-in URL after `setup.signInFlow`

The last action in the flow didn't actually submit, OR the credentials were rejected. The runner aborts with a clear error after 15s:

```
signInFlow completed but browser is still on a sign-in URL: ...
```

Fixes:
- Run with `--headed` and watch the actual form state
- Capture the response HTML/network in `.aivion-qa/reports/<run>/trace.zip`
- Verify selectors with devtools
- For provider-specific issues (HIBP, 2FA, device verification), see [docs/auth/clerk.md](auth/clerk.md)

## Failed test but the error message is cryptic

Open the run's trace:

```bash
pnpm exec playwright show-trace .aivion-qa/reports/<timestamp>_<plan>/trace.zip
```

Gives you a full interactive timeline: every action, every network call, every DOM snapshot. The failing step is highlighted.

## Section hierarchy stops too early

If the first section's cases are genuinely independent from the rest, and you want downstream sections to still run, either:
- Re-organize so the independent section isn't first, OR
- Remove the `{run_id}` coupling so each section can run standalone

Section 1 is treated as the foundation by design — if login or fixture setup is in section 1 and breaks, running anything else is meaningless.

## Test user piling up after crashed runs

Teardown failed mid-run. The next successful run's `cleanupUserData: true` clears the DB side; provider-side cleanup depends on which auth you use:

- **Clerk** — next run's `auth.cleanupUser` will delete any stale user by email; or delete manually in the Clerk dashboard (never conflicts with new runs since each uses a unique email)
- **Local auth** — no separate account to clean; DB cleanup handles it

## Provider-specific issues

See the auth guide for your provider:
- [docs/auth/local.md](auth/local.md) — in-app auth
- [docs/auth/clerk.md](auth/clerk.md) — Clerk (HIBP, test mode, 2FA, sign-in ticket, device verification)
