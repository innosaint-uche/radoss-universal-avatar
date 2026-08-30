import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluateReleaseGate, validateEvidenceStandard } from "../lib/release-gate.mjs";

const evidenceStandard = {
  version: "1.0",
  source_authority: "docs/design/NAAS-Avatar-OS-Productisation-System-Design.pdf#page=18",
  fact_recommendation_separation: "enforced",
  adapter_reverification: "required_on_host_change",
  adapter_records: [{
    adapter: "fixture",
    status: "observed",
    fact_sources: ["fixture-source"],
    verified_at: "2026-08-25"
  }]
};

function completeEvidence() {
  return {
    evidence_standard: evidenceStandard,
    release_identity: {
      source_marker: "source-sha",
      deployment_id: "deployment-id"
    },
    remote_gateway: {
      conformance: "pass",
      oauth: "pass",
      tenant_isolation: "pass",
      branded_route: "verified"
    },
    host_acceptance: { chatgpt: "accepted", claude: "accepted" },
    source_release: { visibility: "public", repository: "verified", clean_tag: "verified" },
    security: { secret_scan: "pass", credential_remediation: "verified" },
    distribution: { signing: "verified", notarization: "verified", platforms: "verified" }
  };
}

function completeIndividualEvidence() {
  return {
    evidence_standard: evidenceStandard,
    release_identity: { source_marker: "individual-source-sha" },
    local_validation: { tauri: "pass", oauth: "pass" },
    source_release: { visibility: "public", repository: "verified" },
    security: { secret_scan: "pass", credential_remediation: "verified" },
    distribution: { signing: "verified", notarization: "verified", platforms: "verified" }
  };
}

test("evidence standard requires facts/recommendations separation and adapter records", () => {
  assert.equal(validateEvidenceStandard({}).valid, false);
  assert.deepEqual(validateEvidenceStandard({}).missing, [
    "evidence_standard.version",
    "evidence_standard.source_authority",
    "evidence_standard.fact_recommendation_separation",
    "evidence_standard.adapter_reverification",
    "evidence_standard.adapter_records"
  ]);
  assert.equal(validateEvidenceStandard(completeEvidence()).valid, true);
});

test("public release is blocked when the evidence standard is absent", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "radoss-release-gate-"));
  const evidencePath = path.join(directory, "evidence.json");
  fs.writeFileSync(evidencePath, JSON.stringify({
    remote_gateway: { conformance: "pass", oauth: "pass", tenant_isolation: "pass" },
    host_acceptance: { chatgpt: "accepted", claude: "accepted" },
    distribution: { signing: "verified", notarization: "verified" }
  }));
  const result = evaluateReleaseGate({
    RADOS_RELEASE_CHANNEL: "public",
    RADOS_RELEASE_EVIDENCE_FILE: evidencePath
  });
  assert.equal(result.status, "blocked");
  assert.ok(result.missing.includes("evidence_standard.adapter_records"));
  fs.rmSync(directory, { recursive: true, force: true });
});

test("public release can pass the evidence-standard layer only with complete records", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "radoss-release-gate-"));
  const evidencePath = path.join(directory, "evidence.json");
  fs.writeFileSync(evidencePath, JSON.stringify(completeEvidence()));
  const result = evaluateReleaseGate({
    RADOS_RELEASE_CHANNEL: "public",
    RADOS_RELEASE_EVIDENCE_FILE: evidencePath
  });
  assert.equal(result.status, "verified");
  assert.equal(result.evidence_standard.valid, true);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("public release requires independently verified source, security, route, and deployment evidence", () => {
  const incomplete = completeEvidence();
  delete incomplete.remote_gateway.branded_route;
  delete incomplete.source_release;
  delete incomplete.security;
  delete incomplete.release_identity.deployment_id;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "radoss-release-gate-"));
  const evidencePath = path.join(directory, "evidence.json");
  fs.writeFileSync(evidencePath, JSON.stringify(incomplete));
  const result = evaluateReleaseGate({
    RADOS_RELEASE_CHANNEL: "public",
    RADOS_RELEASE_EVIDENCE_FILE: evidencePath
  });
  assert.equal(result.status, "blocked");
  assert.ok(result.missing.includes("remote_gateway.branded_route"));
  assert.ok(result.missing.includes("source_release.visibility"));
  assert.ok(result.missing.includes("security.credential_remediation"));
  assert.ok(result.missing.includes("release_identity.deployment_id"));
  fs.rmSync(directory, { recursive: true, force: true });
});

test("individual local handoff does not require hosted multi-user or host acceptance evidence", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "radoss-release-gate-"));
  const evidencePath = path.join(directory, "evidence.json");
  fs.writeFileSync(evidencePath, JSON.stringify(completeIndividualEvidence()));
  const result = evaluateReleaseGate({
    RADOS_RELEASE_CHANNEL: "individual_local",
    RADOS_RELEASE_EVIDENCE_FILE: evidencePath
  });
  assert.equal(result.status, "verified");
  assert.equal(result.release_verified, true);
  assert.equal(result.public_release, false);
  assert.equal(result.channel, "individual_local");
  fs.rmSync(directory, { recursive: true, force: true });
});

test("individual local handoff remains blocked without signed distribution evidence", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "radoss-release-gate-"));
  const evidencePath = path.join(directory, "evidence.json");
  const incomplete = completeIndividualEvidence();
  delete incomplete.distribution.signing;
  fs.writeFileSync(evidencePath, JSON.stringify(incomplete));
  const result = evaluateReleaseGate({
    RADOS_RELEASE_CHANNEL: "individual_local",
    RADOS_RELEASE_EVIDENCE_FILE: evidencePath
  });
  assert.equal(result.status, "blocked");
  assert.ok(result.missing.includes("distribution.signing"));
  fs.rmSync(directory, { recursive: true, force: true });
});
