# Contributing

Contributions are welcome. Start with a reproducible issue or a small, scoped
change that preserves the user-owned Avatar and privacy boundaries.

Before opening a pull request:

```bash
npm ci
npm test
npm audit --omit=dev --audit-level=high
node scripts/check-public-package.mjs
```

Do not commit credentials, OAuth codes, bearer tokens, private Avatar data,
generated local state, or platform-specific home-directory paths. Browser and
live-surface E2E belongs in the external `~/.radoss-qa` harness; do not add a
second Playwright or Rust stack to this repository.

Every change must preserve the distinction between local configuration,
provider authentication, hosted gateway reachability, tenant isolation, and
host-account acceptance.
