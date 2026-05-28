const state = {
  mappings: [],
  apiKey: localStorage.getItem("wixHubspotDemoApiKey") || ""
};

const mappingRows = document.querySelector("#mappingRows");
const connectionBadge = document.querySelector("#connectionBadge");
const logs = document.querySelector("#logs");
const modeValue = document.querySelector("#modeValue");
const apiKeyInput = document.querySelector("#apiKeyInput");

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

const demoIds = {
  wixContactId: "wix_dashboard_demo_contact",
  hubspotContactId: "hs_dashboard_demo_contact",
  formContactId: "wix_dashboard_form_lead"
};

async function api(path, options = {}) {
  const method = options.method || "GET";
  const protectedRoute = method !== "GET";
  const response = await fetch(path, {
    headers: {
      "content-type": "application/json",
      ...(protectedRoute ? { "x-webhook-api-key": state.apiKey } : {}),
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
          <td><input data-field="wixField" value="${escapeHtml(mapping.wixField)}" /></td>
          <td><input data-field="hubspotProperty" value="${escapeHtml(mapping.hubspotProperty)}" /></td>
          <td><select data-field="direction">${optionList(directionOptions, mapping.direction)}</select></td>
          <td><select data-field="transform">${optionList(transformOptions, mapping.transform)}</select></td>
          <td><button class="secondary" data-delete="${index}" type="button">Remove</button></td>
        </tr>
      `
    )
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
  state.mappings = data.mappings;
  connectionBadge.textContent = data.connection.connected
    ? `Connected (${data.connection.mode})`
    : "Disconnected";
  modeValue.textContent = data.connection.mode || "mock";
  connectionBadge.classList.toggle("connected", data.connection.connected);
  document.querySelector("#hubspotCount").textContent = data.mockHubSpotContacts.length;
  document.querySelector("#wixCount").textContent = data.mockWixContacts.length;
  document.querySelector("#mappingCount").textContent = data.contactMappings.length;
  document.querySelector("#formCount").textContent = data.formSubmissions.length;
  renderMappings();
  renderLogs(data.syncEvents);
}

apiKeyInput.value = state.apiKey;
apiKeyInput.addEventListener("input", (event) => {
  state.apiKey = event.currentTarget.value;
  localStorage.setItem("wixHubspotDemoApiKey", state.apiKey);
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
  logs.innerHTML = `<p>${error.message}</p>`;
});
