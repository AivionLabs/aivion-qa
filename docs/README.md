# aivion-qa docs

Main [README](../README.md) covers install + quick start. These guides go deep on specific topics.

## Guides

| Topic | Doc |
|---|---|
| **Plan YAML reference** — full spec for `.aivion-qa/plans/*.yaml` | [plan-reference.md](plan-reference.md) |
| **Troubleshooting** — common errors and fixes | [troubleshooting.md](troubleshooting.md) |

## Auth providers

How to wire `aivion-qa` to your auth layer.

| Provider | Status | Guide |
|---|---|---|
| Local / in-app (NextAuth, custom JWT, session table) | ✅ supported | [auth/local.md](auth/local.md) |
| Clerk | ✅ supported (bundled adapter) | [auth/clerk.md](auth/clerk.md) |
| Auth0 | 🚧 planned v0.2 | — |
| Okta | 🚧 planned v0.3 | — |
| Supabase | 🚧 planned v0.2 | — |

If your provider isn't listed, use the [local pattern](auth/local.md) — skip the adapter, drive the login UI in `setup.signInFlow`.
