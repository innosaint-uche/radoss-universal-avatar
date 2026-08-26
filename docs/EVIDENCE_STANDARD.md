# Evidence Standard

**Authority:** `Documents/NAAS/docs/design/NAAS-Avatar-OS-Productisation-System-Design.pdf`, page 18.
**Status:** Enforced by the Universal release gate.
**Rule:** A successful command is not, by itself, evidence that a product or
integration works.

## Normative rules

1. Separate **facts** from **recommendations**.
   - **Fact:** an observed result, source-backed requirement, or recorded
     decision that can be independently checked.
   - **Recommendation:** a proposed choice or next action. It must never be
     reported as an observed capability.
2. Platform-specific details belong to the relevant adapter. The core product
   must not guess host paths, OAuth behavior, UI acceptance, protocol versions,
   or account state.
3. When a host or provider version changes, the adapter owner must re-check its
   official documentation, rerun the adapter's behavioral probe, and update the
   evidence record before the integration is called verified.
4. Evidence is time-bound and traceable. Every adapter record names its source,
   status, and verification date. Secrets and bearer values are never evidence
   payloads.
5. A release claim is fail-closed. Missing or malformed evidence keeps the
   release in local-validation status.

## Machine-enforced manifest layer

Public release manifests must contain:

```json
{
  "evidence_standard": {
    "version": "1.0",
    "source_authority": "docs/design/NAAS-Avatar-OS-Productisation-System-Design.pdf#page=18",
    "fact_recommendation_separation": "enforced",
    "adapter_reverification": "required_on_host_change",
    "adapter_records": [
      {
        "adapter": "adapter-name",
        "status": "observed|pending|blocked",
        "fact_sources": ["path-or-official-url"],
        "verified_at": "YYYY-MM-DD",
        "recommendations": ["optional, clearly labelled"]
      }
    ]
  }
}
```

The release gate rejects a public manifest when the standard block or any
adapter record is missing. It also requires independently verified remote
gateway routing, tenant isolation, host acceptance, public source visibility
with a clean tagged release, deployment identity, security scanning and
credential remediation, and signed/notarised artifacts for every advertised
platform. A record can honestly be `pending` or `blocked`; that status is
useful evidence, but it cannot be used to claim the adapter is verified.

## Reporting format

Use this order in QA, product, CTO and release reports:

| Type | Required content |
|---|---|
| Observed | command or interaction, date, environment, result, artifact/source |
| Decision | approved direction and its owner |
| Recommendation | proposed action, rationale, and whether it is implemented |
| Blocked | exact missing evidence or external dependency |

Never convert “the browser page opened”, “the package built”, “the endpoint
responded”, or “the host is configured” into “the account is connected” or
“the integration works” without the corresponding behavioral proof.

## Adapter change protocol

For every host/provider change:

1. Identify the affected adapter and its official documentation source.
2. Record the host/provider version and verification date.
3. Re-run configuration mutation, reload/restart, and a real behavioral probe.
4. Check secrets, scope/tenant boundaries, rollback, and user-facing status.
5. Update the adapter record and release evidence.
6. Keep the release blocked if any required evidence is still pending.

This standard applies to Codex, Antigravity, Hermes, ChatGPT, Claude, MCP
providers, memory projections, Tauri packaging, cloud hosting and future
adapters—not only to NAAS.
