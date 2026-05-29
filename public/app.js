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
  pollingValue.textContent = checkpoint
    ? `${checkpoint.status} (${checkpoint.lastSeenModifiedAt || "no checkpoint"})`
    : data.webhookRegistrations?.[0]?.status || "Not configured";
  wixInstallValue.textContent =
    state.mode === "real"
      ? data.connection.wixTokenExpiresAt
        ? `Installed (token until ${data.connection.wixTokenExpiresAt})`
        : "Installed"
      : "Local mock";
  lastSyncValue.textContent = data.syncEvents?.[0]?.createdAt || "None";
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

document.querySelector("#connectBtn").addEventListener("click", async () => {
  const result = await api("/api/auth/hubspot/connect", { method: "POST" });
  if (result.redirectUrl) window.location.href = result.redirectUrl;
  await refresh();
});

document.querySelector("#disconnectBtn").addEventListener("click", async () => {
  await api("/api/auth/hubspot/disconnect", { method: "POST" });
  await refresh();
});

document.querySelector("#pollHubspotBtn").addEventListener("click", async () => {
  await api("/api/poll/hubspot", { method: "POST", body: JSON.stringify({}) });
  await refresh();
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

document.querySelector("#saveMappingsBtn").addEventListener("click", async () => {
  await api("/api/mappings", {
    method: "POST",
    body: JSON.stringify({ mappings: collectMappings() })
  });
  await refresh();
});

mappingRows.addEventListener("click", (event) => {
  const index = event.target.dataset.delete;
  if (index === undefined) return;
  state.mappings.splice(Number(index), 1);
  renderMappings();
});

document.querySelector("#wixContactForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  await api("/api/sync/wix-contact", {
    method: "POST",
    body: JSON.stringify({
      wixContactId: demoIds.wixContactId,
      updatedAt: new Date().toISOString(),
      fields: formToObject(event.currentTarget)
    })
  });
  await refresh();
});

document.querySelector("#hubspotContactForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  await api("/api/sync/hubspot-contact", {
    method: "POST",
    body: JSON.stringify({
      hubspotContactId: demoIds.hubspotContactId,
      updatedAt: new Date().toISOString(),
      properties: formToObject(event.currentTarget)
    })
  });
  await refresh();
});

document.querySelector("#formSubmissionForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = formToObject(event.currentTarget);
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
});
