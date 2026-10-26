# NAAvOS local runtime engineering contract

This repository supplies the desktop/runtime layer for the main [NAAvOS product](https://github.com/innosaint-uche/naavos). Read its release charter and CTO audit before changing product or readiness claims.

- Keep identity/preferences/memory canonical in local SQLite. Treat the JSON compiler export and ReMe output as projections.
- Preserve existing profiles and adjacent host configuration. Never overwrite an externally edited compiler source. Use private backups and isolated test homes.
- No automatic capture, cloud sync or provider login. Mutating MCP tools require explicit confirmation. Paused mode must block every private context path.
- Run `npm test`, the browser journey, package preflight and the production dependency audit for relevant changes. Desktop edits also require target-OS packaging and `scripts/verify-packaged-sidecar.mjs`.
- Browser tests, local fixtures and unsigned binaries do not prove a production release. Keep the central `~/.radoss-qa` and signed-distribution gates explicit when their evidence is unavailable.
- The founder's external `system_prompts/CTO_GUARDRAILS.md` and `system_prompts/AGENT_ROUTING.md` are companion references when supplied. Do not invent their contents or credential references.
