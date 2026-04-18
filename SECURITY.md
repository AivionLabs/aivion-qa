# Security policy

## Reporting a vulnerability

If you believe you've found a security issue in `aivion-qa`, please **do not open a public GitHub issue**. Email instead:

**security@aivionlabs.com**

Include:
- A clear description of the issue and its impact
- Steps to reproduce (minimal repro preferred)
- Affected version(s)
- Any proof-of-concept or exploit code

We aim to acknowledge reports within **3 working days** and ship a fix or mitigation within **30 days** for confirmed high-severity issues.

## Scope

In scope:
- The `aivion-qa` CLI and its auto-generated SQL for cleanup
- The sign-in token handling (Clerk)
- Credential handling (env var reads)
- Template-resolution injection surfaces

Out of scope:
- Issues in upstream dependencies (report to upstream — Playwright, Clerk, etc.)
- Issues specific to your app under test
- Social engineering, phishing, physical security

## Disclosure

We practice coordinated disclosure. Once a fix is released, we'll credit the reporter (unless you prefer anonymity) in the release notes and publish a brief advisory on the GitHub repo.
