const $ = (selector) => document.querySelector(selector);
const statusEl = $("#overall-status");
const lastActionEl = $("#last-action");
const releaseStatusEl = $("#release-status");
const API_BASE =
  window.__TAURI_INTERNALS__ ||
  ["tauri:", "asset:"].includes(window.location.protocol)
    ? "http://127.0.0.1:49312"
    : "";
let primaryAction = "setup";
let busy = false;
let initialRefresh = Promise.resolve();
let privacyDirty = false;

function safeMessage(value) {
  return String(value || "")
    .replace(/https?:\/\/\S+/gi, "[provider URL]")
    .replace(
      /(access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key)\s*[:=]\s*\S+/gi,
      "$1: [redacted]",
    );
}

function syncBusyControls() {
  for (const button of document.querySelectorAll("button")) {
    if (button.id === "refresh-button") continue;
    button.disabled = busy || button.dataset.blocked === "true";
  }
  const name = $("#avatar-name");
  if (name) name.disabled = busy;
}

function setBusy(value) {
  busy = value;
  syncBusyControls();
}

function setAction(message) {
  lastActionEl.textContent = message;
}

async function request(url, options = {}) {
  const init = {
    ...options,
    headers: {
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
  };
  if (options.body) init.body = JSON.stringify(options.body);
  let response;
  let lastError;
  for (let attempt = 0; attempt < (API_BASE ? 12 : 1); attempt += 1) {
    try {
      response = await fetch(`${API_BASE}${url}`, init);
      break;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (!response) throw lastError ?? new Error("Setup service unavailable");
  const body = await response.json();
  if (!response.ok)
    throw new Error(body.error || `Request failed: ${response.status}`);
  return body;
}

function row(title, meta, status, statusClass = "", action = null) {
  const element = document.createElement("div");
  element.className = "row";
  const details = document.createElement("div");
  const titleElement = document.createElement("div");
  titleElement.className = "row-title";
  titleElement.textContent = title;
  const metaElement = document.createElement("div");
  metaElement.className = "row-meta";
  metaElement.textContent = meta;
  details.append(titleElement, metaElement);
  const statusElement = document.createElement("div");
  statusElement.className = `row-status ${statusClass}`;
  statusElement.textContent = status;
  if (action) {
    const actions = document.createElement("div");
    actions.className = "row-actions";
    actions.append(statusElement);
    const button = document.createElement("button");
    button.className = "secondary small";
    button.type = "button";
    button.textContent = action.label;
    button.addEventListener("click", action.handler);
    actions.append(button);
    element.append(details, actions);
  } else {
    element.append(details, statusElement);
  }
  return element;
}

function emptyRow(container, message) {
  container.replaceChildren();
  const element = document.createElement("p");
  element.className = "muted";
  element.textContent = message;
  container.append(element);
}

function render(data) {
  const setup = data.setup || {};
  const release = data.release || {
    public_release: false,
    label: "Local validation build",
  };
  const authority = data.authority || {};
  const configured = setup.status === "configured";
  const failed = setup.status === "failed";
  const securityWarnings = data.security_warnings || [];
  const providerEntries = Object.values(data.providers || {});
  const localAccountProviders = providerEntries.filter(
    (provider) => provider.id !== "naavos_gateway",
  );
  const accountPending = localAccountProviders.some(
    (provider) =>
      provider.configured &&
      provider.auth === "oauth" &&
      provider.auth_status !== "authenticated",
  );
  const secureStorageUnavailable = localAccountProviders.some(
    (provider) =>
      provider.configured &&
      provider.auth === "oauth" &&
      provider.token_storage?.available === false,
  );
  const configuredLabels = [
    accountPending
      ? secureStorageUnavailable
        ? "Secure storage required"
        : "Connect account"
      : null,
    securityWarnings.length ? "Review security" : null,
  ].filter(Boolean);
  const progressLabel = {
    configuring: "Setting up local Avatar",
    awaiting_browser_oauth: "Waiting for browser approval",
    configuring_orchestrator: "Configuring Hermes",
    running_health_checks: "Running health checks",
  }[setup.phase];
  statusEl.textContent = configured
    ? configuredLabels.length
      ? `Configured · ${configuredLabels.join(" · ")}`
      : "Configured"
    : failed
      ? "Needs retry"
      : setup.status === "not_started"
        ? "Not started"
        : progressLabel || setup.status;
  const setupVerified =
    configured && !securityWarnings.length && !accountPending;
  statusEl.className = `status-pill ${setupVerified ? "good" : "warn"}`;
  const detail = $("#setup-detail");
  if (detail) {
    detail.textContent = setup.last_error
      ? `Setup stopped safely: ${safeMessage(setup.last_error)}. Your previous configuration was restored. Retry will reuse any valid saved account session.`
      : configured && accountPending
        ? "Your local Avatar is ready. Connect the provider account in the browser to finish verification."
        : configured
          ? "Your local Avatar and agent adapters are configured. Use health check to verify the live protocol state."
          : "Your setup is reversible. We create a backup before changing anything.";
  }
  releaseStatusEl.textContent = release.public_release
    ? release.label
    : `${release.label} · not public distribution`;
  releaseStatusEl.className = `release-status ${release.public_release ? "good" : "warn"}`;
  const authorityContainer = $("#authority-status");
  authorityContainer.replaceChildren();
  const localAuthority = authority.local_control_plane || {};
  const hostedGateway = authority.hosted_gateway || {};
  authorityContainer.append(
    row(
      "NAAvOS local control plane",
      "Canonical Avatar authority · Hermes visible orchestrator",
      localAuthority.status === "available" ? "Available" : "Unavailable",
      localAuthority.status === "available" ? "good" : "bad",
    ),
  );
  const hostedStatus =
    hostedGateway.last_check?.status === "protocol_healthy"
      ? "Protocol reachable · account not verified"
      : hostedGateway.status === "configured_unverified"
        ? "Configured · not verified"
        : "Not configured";
  const hostedClass =
    hostedGateway.last_check?.status === "protocol_healthy" ? "good" : "warn";
  authorityContainer.append(
    row(
      "Online Avatar endpoint",
      "Optional locally · needed only for online ChatGPT and Claude connections",
      hostedStatus,
      hostedClass,
    ),
  );
  const hosting = data.hosting || {};
  const hostingMode = hosting.provider === "cloudflare" && hosting.mode === "user_hosted"
    ? "user_hosted_cloudflare"
    : hosting.provider === "coolify" && hosting.mode === "user_hosted"
      ? "user_hosted_coolify"
      : hosting.mode || "local";
  const hostingModeInput = $("#hosting-mode");
  if (hostingModeInput && document.activeElement !== hostingModeInput) hostingModeInput.value = hostingMode;
  const hostingEndpointFields = $("#hosting-endpoint-fields");
  const hostingEndpointInput = $("#hosting-endpoint");
  const hostingConsoleInput = $("#hosting-console-url");
  const onlineChoice = hostingMode !== "local";
  if (hostingEndpointFields) hostingEndpointFields.hidden = !onlineChoice;
  if (hostingEndpointInput && document.activeElement !== hostingEndpointInput && hosting.endpoint) hostingEndpointInput.value = hosting.endpoint;
  const coolifyChoice = hostingMode === "user_hosted_coolify";
  if (hostingConsoleInput) hostingConsoleInput.hidden = !coolifyChoice;
  const consoleLabel = document.querySelector('label[for="hosting-console-url"]');
  if (consoleLabel) consoleLabel.hidden = !coolifyChoice;
  const hostingDetail = $("#hosting-detail");
  if (hostingDetail) hostingDetail.textContent = hosting.next_step || "Choose how your online Avatar should be hosted.";
  const providerButton = $("#hosting-provider-button");
  if (providerButton) providerButton.hidden = !["user_hosted_cloudflare", "user_hosted_coolify", "managed_naas"].includes(hostingMode);
  if (!privacyDirty)
    $("#privacy-mode").value = data.privacy?.mode || "local_only";
  if (data.avatar?.name) $("#avatar-name").value = data.avatar.name;
  primaryAction =
    configured && accountPending
      ? secureStorageUnavailable
        ? "blocked"
        : "connect"
      : "setup";
  $("#setup-button").dataset.blocked =
    primaryAction === "blocked" ? "true" : "false";
  $("#setup-button").textContent =
    primaryAction === "connect"
      ? "Connect account"
      : primaryAction === "blocked"
        ? "Secure storage required"
        : configured
          ? "Run setup again"
          : "Set up my Avatar";

  const projection = data.memory?.projection;
  const projectionContainer = $("#memory-projection");
  projectionContainer.replaceChildren();
  const projectionStatus =
    projection?.status === "healthy"
      ? "Available · local service healthy"
      : projection?.status === "not_installed"
        ? "Optional · not installed"
        : projection?.status === "not_running"
          ? "Installed · service not running"
          : "Not checked";
  const projectionMeta =
    projection?.status === "healthy"
      ? `${projection.endpoint} · SQLite remains canonical`
      : `${projection?.detail || "ReMe remains optional"} · no automatic install`;
  projectionContainer.append(
    row(
      "ReMe",
      projectionMeta,
      projectionStatus,
      projection?.status === "healthy" ? "good" : "",
    ),
  );
  const remeButton = $("#reme-button");
  remeButton.hidden =
    projection?.status === "healthy" || projection?.python?.supported !== true;
  remeButton.textContent =
    projection?.status === "not_running" ? "Start ReMe" : "Set up ReMe";
  const remeProjectButton = $("#reme-project-button");
  remeProjectButton.hidden = projection?.status !== "healthy";

  const agents = $("#agents");
  agents.replaceChildren();
  const agentEntries = Object.entries(data.agents || {});
  if (!agentEntries.length) emptyRow(agents, "No agents detected.");
  for (const [agentId, agent] of agentEntries) {
    const runtime = agent.runtime;
    const runtimeLabel =
      runtime?.status === "configured"
        ? " · Hermes profile verified"
        : runtime?.status === "not_available"
          ? " · Hermes app not detected"
          : "";
    const status =
      agent.mode === "automatic"
        ? agent.configured
          ? `Configured${runtimeLabel}`
          : "Ready to configure"
        : "Connect in host";
    const statusClass =
      agent.configured && (!runtime || runtime.status === "configured")
        ? "good"
        : "";
    const meta =
      agent.role === "visible_orchestrator"
        ? `${agent.label} · visible orchestrator profile`
        : agent.profile
          ? `${agent.label} profile · handled automatically`
          : agent.path || agent.note || "No local adapter";
    const action =
      agent.mode === "account_ui"
        ? { label: `Open ${agent.label}`, handler: () => openHost(agentId) }
        : null;
    agents.append(row(agent.label, meta, status, statusClass, action));
  }

  const providers = $("#providers");
  providers.replaceChildren();
  if (!providerEntries.length) emptyRow(providers, "No provider registered.");
  for (const provider of providerEntries) {
    const hostedGateway = provider.id === "naavos_gateway";
    const healthy =
      provider.adapter_drift?.length &&
      provider.adapter_drift.every((item) => !item.changed);
    const hermesVerified = provider.hermes_runtime?.status === "configured";
    const username = provider.account?.username
      ? ` as ${provider.account.username}`
      : "";
    const auth =
      provider.auth_status === "authenticated"
        ? `Connected${username}`
        : provider.auth_status === "awaiting_browser_oauth"
          ? "Waiting for browser approval"
          : provider.auth_status === "browser_opened"
            ? "Browser login opened"
            : provider.auth_status === "provider_managed_fallback"
              ? "Provider login opened; verification pending"
              : provider.auth_status === "browser_open_skipped"
                ? "Browser login not opened"
                : provider.auth_status || "Not connected";
    const storageIssue =
      provider.auth === "oauth" && provider.token_storage?.available === false;
    const evidence = hostedGateway
      ? "Hosted gateway · separate acceptance required"
      : storageIssue
        ? `Secure storage required · ${provider.token_storage.backend}`
        : hermesVerified
          ? "Protocol in sync · Hermes verified"
          : healthy
            ? "Protocol in sync"
            : "Needs setup";
    const status = hostedGateway ? "Checked separately" : auth;
    const meta = hostedGateway
      ? `${provider.endpoint} · ChatGPT/Claude gateway`
      : `${provider.endpoint} · ${auth}`;
    providers.append(
      row(
        provider.label,
        meta,
        hostedGateway ? status : evidence,
        hostedGateway
          ? ""
          : healthy && (!provider.hermes_runtime || hermesVerified)
            ? "good"
            : "",
      ),
    );
  }

  const securityCard = $("#security-card");
  const securityContainer = $("#security-warnings");
  securityContainer.replaceChildren();
  securityCard.hidden = securityWarnings.length === 0;
  for (const warning of securityWarnings) {
    securityContainer.append(
      row(
        `${warning.target}: ${warning.field}`,
        `${warning.path} · ${warning.action}`,
        "Action required",
        "bad",
      ),
    );
  }
  syncBusyControls();
}

function hostingRequestFromUi() {
  const mode = $("#hosting-mode").value;
  const endpoint = $("#hosting-endpoint").value.trim() || null;
  if (mode === "local") return { mode: "local" };
  if (mode === "existing_endpoint") return { mode, provider: "existing", endpoint };
  if (mode === "user_hosted_cloudflare") return { mode: "user_hosted", provider: "cloudflare", endpoint };
  if (mode === "user_hosted_coolify") return { mode: "user_hosted", provider: "coolify", endpoint };
  return { mode: "managed_naas", provider: "naas", endpoint };
}

async function refresh() {
  try {
    render(await request("/api/status"));
  } catch (error) {
    statusEl.textContent = "Setup service unavailable";
    statusEl.className = "status-pill warn";
    setAction(error.message);
  }
}

async function runSetup() {
  if (busy) return;
  await initialRefresh;
  setBusy(true);
  setAction("Setting up local Avatar and supported agents…");
  const progressTimer = window.setInterval(refresh, 750);
  try {
    await request("/api/setup/run", {
      method: "POST",
      body: {
        provider: "huggingface",
        targets: ["codex", "antigravity", "hermes"],
        openAuth: true,
        avatarName: $("#avatar-name").value,
      },
    });
    setAction(
      "Setup complete. Account status and protocol health are shown below.",
    );
    await refresh();
  } catch (error) {
    setAction(error.message);
    await refresh();
  } finally {
    window.clearInterval(progressTimer);
    setBusy(false);
  }
}

async function retrySetup() {
  if (busy) return;
  await initialRefresh;
  setBusy(true);
  setAction("Retrying the last setup request…");
  try {
    const result = await request("/api/setup/retry", {
      method: "POST",
      body: { openAuth: true, avatarName: $("#avatar-name").value },
    });
    if (result.status === "blocked") {
      setAction(result.error);
      await refresh();
      return;
    }
    setAction(
      "Retry complete. Account status and protocol health are shown below.",
    );
    await refresh();
  } catch (error) {
    setAction(error.message);
    await refresh();
  } finally {
    setBusy(false);
  }
}

async function connectAccount() {
  if (busy) return;
  await initialRefresh;
  setBusy(true);
  setAction("Opening a secure browser connection…");
  const progressTimer = window.setInterval(refresh, 750);
  try {
    const result = await request("/api/auth/connect", {
      method: "POST",
      body: { provider: "huggingface" },
    });
    setAction(
      result.status === "authenticated"
        ? "Account connected and verified."
        : "Browser connection opened. Approve it in the provider window, then refresh.",
    );
    await refresh();
  } catch (error) {
    setAction(error.message);
    await refresh();
  } finally {
    window.clearInterval(progressTimer);
    setBusy(false);
  }
}

async function openHost(agentId) {
  await initialRefresh;
  setAction("Opening the host connection page…");
  try {
    const result = await request("/api/host/open", {
      method: "POST",
      body: { agent: agentId },
    });
    setAction(
      result.status === "browser_open_skipped"
        ? "Host connection page not opened in test mode."
        : `${result.label} opened. Complete the connection in that host, then refresh.`,
    );
  } catch (error) {
    setAction(error.message);
  }
}

$("#setup-button").addEventListener("click", () => {
  if (primaryAction === "blocked") return;
  primaryAction === "connect" ? connectAccount() : runSetup();
});
$("#retry-button").addEventListener("click", retrySetup);
$("#privacy-mode").addEventListener("change", () => {
  privacyDirty = true;
});
$("#privacy-button").addEventListener("click", async () => {
  const mode = $("#privacy-mode").value;
  try {
    await initialRefresh;
    await request("/api/privacy", { method: "POST", body: { mode } });
    privacyDirty = false;
    setAction("Privacy choice saved.");
    await refresh();
  } catch (error) {
    setAction(error.message);
  }
});
$("#refresh-button").addEventListener("click", refresh);
$("#hosting-mode").addEventListener("change", () => {
  const mode = $("#hosting-mode").value;
  const online = mode !== "local";
  $("#hosting-endpoint-fields").hidden = !online;
  const coolify = mode === "user_hosted_coolify";
  $("#hosting-console-url").hidden = !coolify;
  document.querySelector('label[for="hosting-console-url"]').hidden = !coolify;
  $("#hosting-provider-button").hidden = !["user_hosted_cloudflare", "user_hosted_coolify", "managed_naas"].includes(mode);
});
$("#hosting-save-button").addEventListener("click", async () => {
  try {
    await initialRefresh;
    const result = await request("/api/hosting/configure", { method: "POST", body: hostingRequestFromUi() });
    setAction(`Hosting choice saved. ${result.hosting.next_step}`);
    await refresh();
  } catch (error) {
    setAction(error.message);
    await refresh();
  }
});
$("#hosting-provider-button").addEventListener("click", async () => {
  const mode = $("#hosting-mode").value;
  const provider = mode === "user_hosted_cloudflare" ? "cloudflare" : mode === "user_hosted_coolify" ? "coolify" : "naas";
  try {
    const result = await request("/api/hosting/open", {
      method: "POST",
      body: { provider, instanceUrl: $("#hosting-console-url").value.trim() || null },
    });
    setAction(result.skipped ? "Provider page opening skipped in test mode." : "Provider page opened. Return here after deployment to verify your endpoint.");
  } catch (error) {
    setAction(error.message);
  }
});
$("#doctor-button").addEventListener("click", async () => {
  setAction("Running local, provider, and hosted-gateway health checks…");
  try {
    await initialRefresh;
    const result = await request("/api/doctor", { method: "POST", body: {} });
    const hosted = result.authority?.hosted_gateway;
    setAction(
      hosted?.status === "protocol_healthy"
        ? "Health checks complete. Hosted MCP is reachable; account and tenant verification remain separate."
        : "Health checks complete. Local/provider evidence is shown separately from hosted-gateway readiness.",
    );
    await refresh();
  } catch (error) {
    setAction(error.message);
  }
});
$("#reme-button").addEventListener("click", async () => {
  if (
    !window.confirm(
      "Set up ReMe in an isolated local environment and start its local service? No Avatar memory will be copied until you explicitly choose to project it.",
    )
  )
    return;
  setAction("Setting up the optional local ReMe memory projection…");
  try {
    await request("/api/memory/reme/setup", {
      method: "POST",
      body: { confirm: true },
    });
    setAction("ReMe is ready. SQLite remains the canonical Avatar ledger.");
    await refresh();
  } catch (error) {
    setAction(error.message);
    await refresh();
  }
});
$("#reme-project-button").addEventListener("click", async () => {
  if (
    !window.confirm(
      "Project only memories you already approved into readable ReMe Markdown files? SQLite remains the canonical Avatar ledger.",
    )
  )
    return;
  setAction("Projecting approved Avatar memory into ReMe…");
  try {
    const result = await request("/api/memory/reme/project", {
      method: "POST",
      body: { confirm: true },
    });
    setAction(
      `${result.count} approved memories projected. SQLite remains canonical.`,
    );
    await refresh();
  } catch (error) {
    setAction(error.message);
    await refresh();
  }
});
$("#backup-button").addEventListener("click", async () => {
  try {
    await initialRefresh;
    const result = await request("/api/backup", {
      method: "POST",
      body: { reason: "user-requested" },
    });
    setAction(`Backup created: ${result.id}`);
    await refresh();
  } catch (error) {
    setAction(error.message);
  }
});
$("#rollback-button").addEventListener("click", async () => {
  try {
    await initialRefresh;
    const backups = await request("/api/backups");
    const latest = backups[0];
    if (!latest) {
      setAction("There is no backup to restore yet.");
      return;
    }
    if (
      !window.confirm(
        `Restore the latest backup from ${latest.created_at}? Current setup changes will be replaced.`,
      )
    )
      return;
    const result = await request("/api/rollback", {
      method: "POST",
      body: { id: latest.id },
    });
    setAction(`Restored backup: ${result.id}`);
    await refresh();
  } catch (error) {
    setAction(error.message);
    await refresh();
  }
});
$("#disconnect-button").addEventListener("click", async () => {
  if (
    !window.confirm(
      "Disconnect Hugging Face, remove its supported agent entries, and delete its saved browser credential? A backup will be created first. Reconnecting may be required after rollback.",
    )
  )
    return;
  try {
    await initialRefresh;
    const result = await request("/api/disconnect", {
      method: "POST",
      body: { provider: "huggingface" },
    });
    setAction(
      `Disconnected Universal and Hermes provider sessions. Backup created: ${result.backup.id}`,
    );
    await refresh();
  } catch (error) {
    setAction(error.message);
    await refresh();
  }
});

initialRefresh = refresh();
