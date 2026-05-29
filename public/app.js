const state = {
  mappings: [],
  apiKey: localStorage.getItem("wixHubspotDemoApiKey") || "",
  wixToken: localStorage.getItem("wixHubspotInstanceToken") || "",
  mode: "mock"
};

const mappingRows = document.querySelector("#mappingRows");
const connectionBadge = document.querySelector("#connectionBadge");
const logs = document.querySelector("#logs");
const modeValue = document.querySelector("#modeValue");
const apiKeyInput = document.querySelector("#apiKeyInput");
const wixTokenInput = document.querySelector("#wixTokenInput");
const authModeValue = document.querySelector("#authModeValue");
const pollingValue = document.querySelector("#pollingValue");
const wixInstallValue = document.querySelector("#wixInstallValue");
const lastSyncValue = document.querySelector("#lastSyncValue");
const retryValue = document.querySelector("#retryValue");
const wixFieldOptions = document.querySelector("#wixFieldOptions");
const hubspotPropertyOptions = document.querySelector("#hubspotPropertyOptions");
const toastRegion = document.querySelector("#toastRegion");
const pollHubspotBtn = document.querySelector("#pollHubspotBtn");

const directionOptions = [
  ["bidirectional", "Bi-directional"],
  ["wix-to-hubspot", "Wix -> HubSpot"],
  ["hubspot-to-wix", "HubSpot -> Wix"]
];

const transformOptions = [
  ["none", "None"],
  ["trim", "Trim"],
  ["lowercase", "Lowercase"],
  ["uppercase", "Uppercase"]
];

const wixFieldCatalog = [
  "email",
  "firstName",
  "lastName",
  "phone",
  "company",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "pageUrl",
  "referrer"
];

const hubspotPropertyCatalog = [
  "email",
  "firstname",
  "lastname",
  "phone",
  "company",
  "wix_utm_source",
  "wix_utm_medium",
  "wix_utm_campaign",
  "wix_utm_term",
  "wix_utm_content",
  "wix_page_url",
  "wix_referrer"
];

const demoIds = {
  wixContactId: "wix_dashboard_demo_contact",
  hubspotContactId: "hs_dashboard_demo_contact",
  formContactId: "wix_dashboard_form_lead"
};

async function api(path, options = {}) {
  const method = options.method || "GET";
  const protectedRoute = method !== "GET" || path === "/api/catalogs" || path === "/api/state";
  const response = await fetch(path, {
    headers: {
      "content-type": "application/json",
      ...(protectedRoute && state.wixToken ? { authorization: `Bearer ${state.wixToken}` } : {}),
      ...(protectedRoute && !state.wixToken ? { "x-webhook-api-key": state.apiKey } : {}),
      ...(options.headers || {})
    },
    ...options
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function showToast(message, type = "success") {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  toastRegion.append(toast);
  window.setTimeout(() => {
    toast.classList.add("leaving");
    window.setTimeout(() => toast.remove(), 220);
  }, 4200);
}

function humanDate(value) {
  if (!value) return "None";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

async function runAction(button, busyLabel, action, successMessage) {
  const originalLabel = button.textContent;
  button.disabled = true;
  button.classList.add("busy");
  button.textContent = busyLabel;
  try {
    const result = await action();
    if (successMessage) showToast(successMessage, "success");
    return result;
  } catch (error) {
    showToast(error.message || "Something went wrong.", "error");
    throw error;
  } finally {
    button.disabled = false;
    button.classList.remove("busy");
    button.textContent = originalLabel;
  }
}

function formToObject(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function optionList(options, selected) {
  return options
    .map(([value, label]) => `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`)
    .join("");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderMappings() {
  mappingRows.innerHTML = state.mappings
    .map(
        (mapping, index) => `
        <tr data-index="${index}">
          <td><input data-field="wixField" list="wixFieldOptions" value="${escapeHtml(mapping.wixField)}" /></td>
          <td><input data-field="hubspotProperty" list="hubspotPropertyOptions" value="${escapeHtml(mapping.hubspotProperty)}" /></td>
          <td><select data-field="direction">${optionList(directionOptions, mapping.direction)}</select></td>
          <td><select data-field="transform">${optionList(transformOptions, mapping.transform)}</select></td>
          <td><button class="secondary" data-delete="${index}" type="button">Remove</button></td>
        </tr>
      `
    )
    .join("");
}

function renderCatalogOptions() {
  wixFieldOptions.innerHTML = wixFieldCatalog.map((field) => `<option value="${escapeHtml(field)}"></option>`).join("");
  hubspotPropertyOptions.innerHTML = hubspotPropertyCatalog
    .map((property) => `<option value="${escapeHtml(property)}"></option>`)
    .join("");
}

function collectMappings() {
  return [...mappingRows.querySelectorAll("tr")].map((row, index) => {
    const current = state.mappings[index] || {};
    const get = (field) => row.querySelector(`[data-field="${field}"]`).value.trim();
    return {
      id: current.id,
      wixField: get("wixField"),
      hubspotProperty: get("hubspotProperty"),
      direction: get("direction"),
      transform: get("transform")
    };
  });
}

function renderLogs(events) {
  logs.innerHTML =
    events
      .map(
        (event) => `
          <div class="logItem ${event.status === "skipped" ? "skipped" : ""}">
            <strong>${escapeHtml(event.message)}</strong>
            <span>${escapeHtml(event.createdAt)} | status: ${escapeHtml(event.status)} | source: ${escapeHtml(event.source)} | syncId: ${escapeHtml(event.syncId)}</span>
            <code>${escapeHtml(JSON.stringify(event.details || {}, null, 2))}</code>
          </div>
        `
      )
      .join("") || "<p>No sync activity yet.</p>";
}

async function refresh() {
  const data = await api("/api/state");
  api("/api/catalogs")
    .then((catalogs) => {
      wixFieldCatalog.splice(0, wixFieldCatalog.length, ...catalogs.wixFields.map((field) => field.name));
      hubspotPropertyCatalog.splice(
        0,
        hubspotPropertyCatalog.length,
        ...catalogs.hubspotProperties.map((property) => property.name)
      );
      renderCatalogOptions();
    })
    .catch(() => {});
  state.mappings = data.mappings;
  state.mode = data.connection.mode || "mock";
  connectionBadge.textContent = data.connection.connected
    ? `Connected (${data.connection.mode})`
    : "Disconnected";
  modeValue.textContent = state.mode;
  authModeValue.textContent = state.mode === "real" ? "Wix signed token" : "API key enabled";
  apiKeyInput.closest("div").classList.toggle("realAuth", state.mode === "real");
  apiKeyInput.hidden = state.mode === "real";
  wixTokenInput.hidden = state.mode !== "real";
  document.querySelectorAll(".mockOnly").forEach((element) => {
    element.hidden = state.mode === "real";
  });
  document.querySelector("#recordsTitle").textContent = state.mode === "real" ? "Production State" : "Demo Records";
  const checkpoint = (data.pollingCheckpoints || []).find((item) => item.provider === "hubspot");
  const pollingAvailable = state.mode === "real" && data.connection.connected;
  pollingValue.textContent = checkpoint
    ? `${checkpoint.status} (${humanDate(checkpoint.lastSeenModifiedAt)})`
    : data.webhookRegistrations?.[0]?.status || "Not configured";
  pollHubspotBtn.disabled = !pollingAvailable;
  pollHubspotBtn.title = pollingAvailable
    ? "Run the HubSpot polling fallback."
    : "Polling is only available after a real HubSpot connection is configured.";
  wixInstallValue.textContent =
    state.mode === "real"
      ? data.connection.wixTokenExpiresAt
        ? `Installed until ${humanDate(data.connection.wixTokenExpiresAt)}`
        : "Installed"
      : "Local mock";
  lastSyncValue.textContent = humanDate(data.syncEvents?.[0]?.createdAt);
  const pendingRetries = (data.retryJobs || []).filter((job) => job.status === "pending").length;
  retryValue.textContent = `${pendingRetries} pending`;
  connectionBadge.classList.toggle("connected", data.connection.connected);
  document.querySelector("#hubspotCount").textContent = data.mockHubSpotContacts.length;
  document.querySelector("#wixCount").textContent = data.mockWixContacts.length;
  document.querySelector("#mappingCount").textContent = data.contactMappings.length;
  document.querySelector("#formCount").textContent = data.formSubmissions.length;
  renderMappings();
  renderLogs(data.syncEvents);
}

apiKeyInput.value = state.apiKey;
wixTokenInput.value = state.wixToken;
renderCatalogOptions();
apiKeyInput.addEventListener("input", (event) => {
  state.apiKey = event.currentTarget.value;
  localStorage.setItem("wixHubspotDemoApiKey", state.apiKey);
});
wixTokenInput.addEventListener("input", (event) => {
  state.wixToken = event.currentTarget.value;
  localStorage.setItem("wixHubspotInstanceToken", state.wixToken);
});

document.querySelector("#connectBtn").addEventListener("click", async (event) => {
  await runAction(
    event.currentTarget,
    "Connecting...",
    async () => {
      const result = await api("/api/auth/hubspot/connect", { method: "POST" });
      if (result.redirectUrl) window.location.href = result.redirectUrl;
      await refresh();
    },
    "HubSpot connection is ready."
  );
});

document.querySelector("#disconnectBtn").addEventListener("click", async (event) => {
  await runAction(
    event.currentTarget,
    "Disconnecting...",
    async () => {
      await api("/api/auth/hubspot/disconnect", { method: "POST" });
      await refresh();
    },
    "HubSpot disconnected."
  );
});

pollHubspotBtn.addEventListener("click", async (event) => {
  if (state.mode !== "real") {
    showToast("Polling is only used in real HubSpot mode. Use the mock sync buttons for this local demo.", "error");
    return;
  }
  await runAction(
    event.currentTarget,
    "Polling...",
    async () => {
      await api("/api/poll/hubspot", { method: "POST", body: JSON.stringify({}) });
      await refresh();
    },
    "HubSpot polling completed."
  );
});

document.querySelector("#addMappingBtn").addEventListener("click", () => {
  state.mappings.push({
    wixField: "",
    hubspotProperty: "",
    direction: "bidirectional",
    transform: "none"
  });
  renderMappings();
});

document.querySelector("#saveMappingsBtn").addEventListener("click", async (event) => {
  await runAction(
    event.currentTarget,
    "Saving...",
    async () => {
      await api("/api/mappings", {
        method: "POST",
        body: JSON.stringify({ mappings: collectMappings() })
      });
      await refresh();
    },
    "Field mappings saved."
  );
});

mappingRows.addEventListener("click", (event) => {
  const index = event.target.dataset.delete;
  if (index === undefined) return;
  state.mappings.splice(Number(index), 1);
  renderMappings();
});

document.querySelector("#wixContactForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type='submit']");
  await runAction(
    button,
    "Syncing...",
    async () => {
      await api("/api/sync/wix-contact", {
        method: "POST",
        body: JSON.stringify({
          wixContactId: demoIds.wixContactId,
          updatedAt: new Date().toISOString(),
          fields: formToObject(event.currentTarget)
        })
      });
      await refresh();
    },
    "Wix contact synced to HubSpot."
  );
});

document.querySelector("#hubspotContactForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type='submit']");
  await runAction(
    button,
    "Syncing...",
    async () => {
      await api("/api/sync/hubspot-contact", {
        method: "POST",
        body: JSON.stringify({
          hubspotContactId: demoIds.hubspotContactId,
          updatedAt: new Date().toISOString(),
          properties: formToObject(event.currentTarget)
        })
      });
      await refresh();
    },
    "HubSpot contact synced to Wix."
  );
});

document.querySelector("#formSubmissionForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = formToObject(event.currentTarget);
  const button = event.currentTarget.querySelector("button[type='submit']");
  await runAction(
    button,
    "Capturing...",
    async () => {
      await api("/api/forms/wix-submission", {
        method: "POST",
        body: JSON.stringify({
          ...data,
          wixContactId: demoIds.formContactId,
          updatedAt: new Date().toISOString(),
          pageUrl: "https://demo-wix-site.example/contact",
          referrer: "https://google.com",
          fields: {
            ...data,
            pageUrl: "https://demo-wix-site.example/contact",
            referrer: "https://google.com"
          }
        })
      });
      await refresh();
    },
    "Lead captured with UTM attribution."
  );
});

refresh().catch((error) => {
  const needsWixToken = /signed Wix instance\/app token/i.test(error.message);
  if (needsWixToken) {
    authModeValue.textContent = "Wix signed token";
    apiKeyInput.closest("div").classList.add("realAuth");
  }
  logs.innerHTML = `<p>${escapeHtml(
    needsWixToken
      ? "Production mode requires a signed Wix instance/app token. Paste it in the protected routes field above."
      : error.message
  )}</p>`;
  showToast(error.message || "Could not load dashboard state.", "error");
});
