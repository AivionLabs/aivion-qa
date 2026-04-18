# aivion-qa docs

Per-topic guides. The main [`README.md`](../README.md) at the repo root covers install + generic usage; these dive into provider- and stack-specific details.

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

## Other topics

- *(None yet. Open an issue if something's missing.)*
