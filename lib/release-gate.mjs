import fs from "node:fs";

const REQUIRED_PUBLIC_EVIDENCE = [
  ["remote_gateway.conformance", "pass"],
  ["remote_gateway.oauth", "pass"],
  ["remote_gateway.tenant_isolation", "pass"],
  ["remote_gateway.branded_route", "verified"],
  ["host_acceptance.chatgpt", "accepted"],
  ["host_acceptance.claude", "accepted"],
  ["source_release.visibility", "public"],
  ["source_release.repository", "verified"],
  ["source_release.clean_tag", "verified"],
  ["security.secret_scan", "pass"],
  ["security.credential_remediation", "verified"],
  ["distribution.signing", "verified"],
  ["distribution.notarization", "verified"],
  ["distribution.platforms", "verified"]
];

// An individual desktop handoff has one local owner and does not claim to be
// a multi-tenant hosted service or an accepted ChatGPT/Claude connector.
// It still requires a signed, secure, independently tested product.
const REQUIRED_INDIVIDUAL_EVIDENCE = [
  ["local_validation.tauri", "pass"],
  ["local_validation.oauth", "pass"],
  ["source_release.visibility", "public"],
  ["source_release.repository", "verified"],
  ["security.secret_scan", "pass"],
  ["security.credential_remediation", "verified"],
  ["distribution.signing", "verified"],
  ["distribution.notarization", "verified"],
  ["distribution.platforms", "verified"]
];

// A user-owned online Avatar is still one person's deployment. It needs
// independently verified remote protocol/auth/routing and deployment identity,
// but it does not make the NAAS-managed shared-service claims.
const REQUIRED_INDIVIDUAL_HOSTED_EVIDENCE = [
  ...REQUIRED_INDIVIDUAL_EVIDENCE,
  ["remote_gateway.conformance", "pass"],
  ["remote_gateway.oauth", "pass"],
  ["remote_gateway.route", "verified"],
  ["remote_gateway.tenant_model", "single_owner"],
  ["remote_gateway.owner_isolation", "verified"]
];

const REQUIRED_NONEMPTY_EVIDENCE = [
  "release_identity.source_marker",
];

const REQUIRED_PUBLIC_IDENTITY_EVIDENCE = [
  "release_identity.deployment_id"
];

const REQUIRED_EVIDENCE_STANDARD = [
  ["evidence_standard.version", "1.0"],
  ["evidence_standard.source_authority", "docs/design/NAAS-Avatar-OS-Productisation-System-Design.pdf#page=18"],
  ["evidence_standard.fact_recommendation_separation", "enforced"],
  ["evidence_standard.adapter_reverification", "required_on_host_change"]
];

function readPath(value, path) {
  return path.split(".").reduce((current, key) => current?.[key], value);
}

export function validateEvidenceStandard(evidence) {
  const missing = REQUIRED_EVIDENCE_STANDARD
    .filter(([path, expected]) => readPath(evidence, path) !== expected)
    .map(([path]) => path);
  const records = evidence?.evidence_standard?.adapter_records;
  if (!Array.isArray(records) || records.length === 0) {
    missing.push("evidence_standard.adapter_records");
  }

  const invalidRecords = Array.isArray(records)
    ? records.flatMap((record, index) => {
      const required = ["adapter", "status", "fact_sources", "verified_at"];
      return required
        .filter((key) => {
          const value = record?.[key];
          return key === "fact_sources"
            ? !Array.isArray(value) || value.length === 0
            : typeof value !== "string" || value.trim() === "";
        })
        .map((key) => `evidence_standard.adapter_records[${index}].${key}`);
    })
    : [];

  return {
    valid: missing.length === 0 && invalidRecords.length === 0,
    missing: [...missing, ...invalidRecords]
  };
}

export function evaluateReleaseGate(env = process.env) {
  const requestedChannel = env.RADOS_RELEASE_CHANNEL ?? "local_validation";
  if (!["public", "individual_local", "individual_hosted"].includes(requestedChannel)) {
    return {
      requested_channel: requestedChannel,
      channel: requestedChannel,
      public_release: false,
      release_verified: false,
      status: "not_requested"
    };
  }

  const evidencePath = env.RADOS_RELEASE_EVIDENCE_FILE;
  if (!evidencePath || !fs.existsSync(evidencePath)) {
    return {
      requested_channel: requestedChannel,
      channel: "local_validation",
      public_release: false,
      release_verified: false,
      status: "blocked",
      reason: requestedChannel === "individual_local" || requestedChannel === "individual_hosted"
        ? "individual_release_evidence_missing"
        : "public_release_evidence_missing"
    };
  }

  let evidence;
  try {
    evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  } catch {
    return {
      requested_channel: requestedChannel,
      channel: "local_validation",
      public_release: false,
      release_verified: false,
      status: "blocked",
      reason: requestedChannel === "individual_local" || requestedChannel === "individual_hosted"
        ? "individual_release_evidence_invalid"
        : "public_release_evidence_invalid"
    };
  }

  const evidenceStandard = validateEvidenceStandard(evidence);

  const requiredEvidence = requestedChannel === "individual_local"
    ? REQUIRED_INDIVIDUAL_EVIDENCE
    : requestedChannel === "individual_hosted"
      ? REQUIRED_INDIVIDUAL_HOSTED_EVIDENCE
      : REQUIRED_PUBLIC_EVIDENCE;
  const missing = requiredEvidence
    .filter(([path, expected]) => readPath(evidence, path) !== expected)
    .map(([path]) => path);
  const requiredIdentityEvidence = requestedChannel === "public" || requestedChannel === "individual_hosted"
    ? [...REQUIRED_NONEMPTY_EVIDENCE, ...REQUIRED_PUBLIC_IDENTITY_EVIDENCE]
    : REQUIRED_NONEMPTY_EVIDENCE;
  missing.push(...requiredIdentityEvidence.filter((path) => {
    const value = readPath(evidence, path);
    return typeof value !== "string" || value.trim() === "";
  }));
  missing.push(...evidenceStandard.missing);
  if (missing.length) {
    return {
      requested_channel: requestedChannel,
      channel: "local_validation",
      public_release: false,
      release_verified: false,
      status: "blocked",
      reason: requestedChannel === "individual_local" || requestedChannel === "individual_hosted"
        ? "individual_release_evidence_incomplete"
        : "public_release_evidence_incomplete",
      missing,
      evidence_standard: evidenceStandard
    };
  }

  return {
    requested_channel: requestedChannel,
    channel: requestedChannel,
    public_release: requestedChannel === "public",
    release_verified: true,
    status: "verified",
    evidence: "release_manifest",
    evidence_standard: evidenceStandard
  };
}
