import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { openDatabase } from "./avatar-memory.mjs";
import {
  loadSetupState,
  saveSetupState,
  recordAudit,
  NAAVOS_DIR,
} from "./setup-state.mjs";

export const AVATAR_SOURCE_PATH = path.join(NAAVOS_DIR, "avatar.json");

function text(value, label, limit = 2000, required = false) {
  if (
    typeof value !== "string" ||
    value.length > limit ||
    (required && !value.trim())
  )
    throw new Error(
      `${label} must be ${required ? "non-empty text" : "text"} of at most ${limit} characters`,
    );
  return value.trim();
}

export function getAvatarProfile() {
  const state = loadSetupState();
  if (!state.avatar.id) return null;
  const db = openDatabase();
  try {
    const row = db
      .prepare("SELECT payload FROM avatar_profiles WHERE avatar_id = ?")
      .get(state.avatar.id);
    return row ? JSON.parse(row.payload) : null;
  } finally {
    db.close();
  }
}

/** The local SQLite profile is authoritative. avatar.json is its compiler-compatible export. */
export function saveAvatarProfile(input = {}) {
  const state = loadSetupState();
  if (state.privacy.mode === "paused")
    throw new Error("Avatar editing is paused by the privacy control");
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Profile object is required");
  const allowed = [
    "name",
    "description",
    "tone",
    "structure",
    "verbosity",
    "rules",
  ];
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    throw new Error("Unknown profile field");
  if (
    !Array.isArray(input.rules) ||
    input.rules.length < 1 ||
    input.rules.length > 50
  )
    throw new Error("Provide between 1 and 50 operating rules");
  const previous = getAvatarProfile();
  const at = new Date().toISOString();
  const avatarId = state.avatar.id || crypto.randomUUID();
  const profile = {
    ...previous,
    metadata: {
      package_id: previous?.metadata.package_id || crypto.randomUUID(),
      owner_id: avatarId,
      schema_version: "1.0.0",
      semantic_version: "1.0.0",
      created_at: previous?.metadata.created_at || at,
      updated_at: at,
      source_provenance: "naavos-local-desktop",
    },
    identity: {
      ...previous?.identity,
      name: text(input.name, "Name", 80, true),
      self_description: text(input.description ?? "", "Description"),
    },
    communication: {
      ...previous?.communication,
      tone: text(input.tone, "Tone", 200, true),
      structure: text(input.structure, "Structure", 200, true),
      verbosity: text(input.verbosity, "Verbosity", 200, true),
    },
    operating_rules: input.rules.map((rule, index) => ({
      ...previous?.operating_rules.find((entry) => entry.statement === rule),
      id:
        previous?.operating_rules.find((entry) => entry.statement === rule)
          ?.id || `rule.${crypto.randomUUID()}`,
      statement: text(rule, `Rule ${index + 1}`, 2000, true),
      priority: Math.max(1, 100 - index),
    })),
    privacy: {
      ...previous?.privacy,
      consents: {
        ...previous?.privacy.consents,
        "allow-cloud-sync": false,
        "allow-telemetry": false,
      },
    },
    adapters: ["hermes", "claude-code", "gemini", "cursor", "openclaw"].map(
      (host_id) => ({
        host_id,
        min_adapter_version: "1.0.0",
        unsupported_behaviour_policy: "warn",
      }),
    ),
    evals: [],
  };
  const payload = JSON.stringify(profile, null, 2);
  fs.mkdirSync(NAAVOS_DIR, { recursive: true, mode: 0o700 });
  // Never replace an existing compiler source that this editor did not create.
  if (!previous && fs.existsSync(AVATAR_SOURCE_PATH))
    throw new Error(
      "An existing Avatar source is present. Back it up before creating a desktop profile.",
    );
  if (previous && fs.existsSync(AVATAR_SOURCE_PATH)) {
    const exported = JSON.parse(fs.readFileSync(AVATAR_SOURCE_PATH, "utf8"));
    if (JSON.stringify(exported) !== JSON.stringify(previous))
      throw new Error(
        "Avatar source has external edits. Reconcile them before saving from the editor.",
      );
  }
  const staged = `${AVATAR_SOURCE_PATH}.tmp-${crypto.randomUUID()}`;
  fs.writeFileSync(staged, payload + "\n", { mode: 0o600, flag: "wx" });
  const db = openDatabase();
  try {
    db.exec("BEGIN IMMEDIATE");
    db.prepare(
      "INSERT INTO avatar_profiles (avatar_id, payload) VALUES (?, ?) ON CONFLICT(avatar_id) DO UPDATE SET payload = excluded.payload",
    ).run(avatarId, payload);
    fs.renameSync(staged, AVATAR_SOURCE_PATH);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
    fs.rmSync(staged, { force: true });
  }
  state.avatar = {
    ...state.avatar,
    id: avatarId,
    name: profile.identity.name,
    created_at: state.avatar.created_at || at,
    updated_at: at,
  };
  recordAudit(state, "avatar.profile.saved", { avatar_id: avatarId });
  saveSetupState(state);
  return profile;
}
