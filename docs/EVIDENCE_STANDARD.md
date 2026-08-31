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

## Release profiles

The gate distinguishes three product handoffs:

- `individual_local` verifies one person's signed desktop handoff, local
  OAuth journey, secure distribution, and public source. It does not require
  multi-user hosted tenant testing or ChatGPT/Claude host acceptance.
- `individual_hosted` verifies one person's signed desktop handoff plus that
  person's independently hosted online Avatar endpoint. It requires remote
  protocol/OAuth/route proof, a `single_owner` tenant model, owner-scoped
  isolation, and deployment identity. It does not claim that the shared NAAvOS
  service is multi-tenant safe or that ChatGPT/Claude accepted the connector.
- `public` verifies the shared hosted NAAvOS service and hosted-client promise.
  It additionally requires independent live-user tenant isolation, named
  ChatGPT and Claude acceptance, branded hosted routing, deployment identity,
  and all other public-service evidence.

An individual local handoff must never be described as a hosted service. An
individual hosted handoff must never be described as the shared NAAvOS service.
Conversely, a hosted service must never use a successful single-user local run
as evidence of tenant isolation.

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
with a clean tagged release, deployment identity, security scanning, a
distribution security review, and signed/notarised artifacts for every
advertised platform. A record can honestly be `pending` or `blocked`; that
status is useful evidence, but it cannot be used to claim the adapter is
verified.

Personal-environment warnings are recorded separately from distribution
evidence. A credential already present in an operator's private agent
configuration is not copied into the product, is never read as release
evidence, and must not force changes to that operator's machine before an
isolated sample or public source release can be evaluated. It remains an
operational warning for that personal environment and for any handoff that
explicitly uses that environment.

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
