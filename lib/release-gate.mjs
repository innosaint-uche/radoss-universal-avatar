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

const REQUIRED_NONEMPTY_PUBLIC_EVIDENCE = [
  "release_identity.source_marker",
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
  if (requestedChannel !== "public") {
    return {
      requested_channel: requestedChannel,
      channel: requestedChannel,
      public_release: false,
      status: "not_requested"
    };
  }

  const evidencePath = env.RADOS_RELEASE_EVIDENCE_FILE;
  if (!evidencePath || !fs.existsSync(evidencePath)) {
    return {
      requested_channel: "public",
      channel: "local_validation",
      public_release: false,
      status: "blocked",
      reason: "public_release_evidence_missing"
    };
  }

  let evidence;
  try {
    evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  } catch {
    return {
      requested_channel: "public",
      channel: "local_validation",
      public_release: false,
      status: "blocked",
      reason: "public_release_evidence_invalid"
    };
  }

  const evidenceStandard = validateEvidenceStandard(evidence);

  const missing = REQUIRED_PUBLIC_EVIDENCE
    .filter(([path, expected]) => readPath(evidence, path) !== expected)
    .map(([path]) => path);
  missing.push(...REQUIRED_NONEMPTY_PUBLIC_EVIDENCE.filter((path) => {
    const value = readPath(evidence, path);
    return typeof value !== "string" || value.trim() === "";
  }));
  missing.push(...evidenceStandard.missing);
  if (missing.length) {
    return {
      requested_channel: "public",
      channel: "local_validation",
      public_release: false,
      status: "blocked",
      reason: "public_release_evidence_incomplete",
      missing,
      evidence_standard: evidenceStandard
    };
  }

  return {
    requested_channel: "public",
    channel: "public",
    public_release: true,
    status: "verified",
    evidence: "release_manifest",
    evidence_standard: evidenceStandard
  };
}
