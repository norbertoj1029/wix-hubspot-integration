import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createRealHubSpotAdapter } from "../src/adapters/realHubSpotAdapter.js";
import { createRealWixAdapter } from "../src/adapters/realWixAdapter.js";
import { createRequestHandler } from "../src/server.js";
import { createSqliteStore } from "../src/storage/sqliteStore.js";

const API_KEY = "test-webhook-secret";
const WIX_APP_SECRET = "test-wix-app-secret";
const require = createRequire(import.meta.url);

function signedWixToken(payload, secret = WIX_APP_SECRET) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}

async function withTestApp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "wix-hubspot-test-"));
  const handleRequest = createRequestHandler({
    dbPath: join(dir, "app-db.json"),
    webhookApiKey: API_KEY,
    appBaseUrl: "http://127.0.0.1"
  });

  try {
    await fn({ request: (options) => request(handleRequest, options) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function request(handleRequest, { method = "GET", path, body, rawBody, apiKey = API_KEY, headers = {} } = {}) {
  const requestBody = rawBody !== undefined ? rawBody : body === undefined ? "" : JSON.stringify(body);
  const req = Readable.from(requestBody ? [requestBody] : []);
  req.method = method;
  req.url = path;
  req.headers = body === undefined && rawBody === undefined ? {} : { "content-type": "application/json" };
  req.headers = { ...req.headers, ...headers };
  if (apiKey) req.headers["x-webhook-api-key"] = apiKey;

  return new Promise((resolve) => {
    const chunks = [];
    const res = {
      statusCode: 200,
      headers: {},
      writeHead(statusCode, headers = {}) {
        this.statusCode = statusCode;
        this.headers = headers;
      },
      write(chunk) {
        chunks.push(Buffer.from(chunk));
      },
      end(chunk) {
        if (chunk) chunks.push(Buffer.from(chunk));
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: this.statusCode,
          headers: this.headers,
          text,
          data: text ? JSON.parse(text) : null
        });
      }
    };

    handleRequest(req, res);
  });
}

async function postJson(request, path, body, apiKey = API_KEY) {
  return request({ method: "POST", path, body, apiKey });
}

async function postRaw(request, path, rawBody, apiKey = API_KEY) {
  return request({ method: "POST", path, rawBody, apiKey });
}

async function getState(request) {
  const result = await request({ path: "/api/state", apiKey: null });
  assert.equal(result.status, 200);
  return result.data;
}

test("protected POST route without API key returns 401", async () => {
  await withTestApp(async ({ request }) => {
    const { status, data } = await postJson(request, "/api/mappings", { mappings: [] }, null);

    assert.equal(status, 401);
    assert.match(data.error, /API key/);
  });
});

test("POST /api/mappings with missing mappings returns 400", async () => {
  await withTestApp(async ({ request }) => {
    const { status, data } = await postJson(request, "/api/mappings", {});

    assert.equal(status, 400);
    assert.match(data.error, /mapping/i);
  });
});

test("POST /api/mappings with invalid direction or transform returns 400", async () => {
  await withTestApp(async ({ request }) => {
    const invalidDirection = await postJson(request, "/api/mappings", {
      mappings: [
        {
          wixField: "email",
          hubspotProperty: "email",
          direction: "sideways",
          transform: "lowercase"
        }
      ]
    });
    const invalidTransform = await postJson(request, "/api/mappings", {
      mappings: [
        {
          wixField: "email",
          hubspotProperty: "email",
          direction: "bidirectional",
          transform: "capitalize"
        }
      ]
    });

    assert.equal(invalidDirection.status, 400);
    assert.match(invalidDirection.data.error, /direction/);
    assert.equal(invalidTransform.status, 400);
    assert.match(invalidTransform.data.error, /transform/);
  });
});

test("invalid JSON body returns 400", async () => {
  await withTestApp(async ({ request }) => {
    const result = await postRaw(request, "/api/mappings", "{bad json");

    assert.equal(result.status, 400);
    assert.match(result.data.error, /Invalid JSON/);
  });
});

test("oversized JSON body returns 400", async () => {
  await withTestApp(async ({ request }) => {
    const result = await postRaw(request, "/api/mappings", "x".repeat(1_000_001));

    assert.equal(result.status, 400);
    assert.match(result.data.error, /too large/);
  });
});

test("POST /api/mappings with valid mappings returns 200 and persists rows", async () => {
  await withTestApp(async ({ request }) => {
    const mappings = [
      {
        wixField: "email",
        hubspotProperty: "email",
        direction: "bidirectional",
        transform: "lowercase"
      },
      {
        wixField: "firstName",
        hubspotProperty: "firstname",
        direction: "bidirectional",
        transform: "trim"
      }
    ];

    const { status, data } = await postJson(request, "/api/mappings", { mappings });
    const state = await getState(request);

    assert.equal(status, 200);
    assert.equal(data.mappings.length, 2);
    assert.equal(state.mappings.length, 2);
    assert.equal(state.mappings[0].hubspotProperty, "email");
  });
});

test("POST /api/mappings rejects duplicate HubSpot property mappings", async () => {
  await withTestApp(async ({ request }) => {
    const result = await postJson(request, "/api/mappings", {
      mappings: [
        { wixField: "email", hubspotProperty: "email", direction: "bidirectional", transform: "lowercase" },
        { wixField: "firstName", hubspotProperty: "email", direction: "bidirectional", transform: "trim" }
      ]
    });

    assert.equal(result.status, 400);
    assert.match(result.data.error, /Duplicate HubSpot property/);
  });
});

test("sync and form routes return 400 for payloads without useful identity data", async () => {
  await withTestApp(async ({ request }) => {
    const wixSync = await postJson(request, "/api/sync/wix-contact", { fields: { firstName: "Missing" } });
    const hubSpotSync = await postJson(request, "/api/sync/hubspot-contact", {
      properties: { firstname: "Missing" }
    });
    const form = await postJson(request, "/api/forms/wix-submission", {
      fields: { firstName: "Missing" }
    });

    assert.equal(wixSync.status, 400);
    assert.match(wixSync.data.error, /wixContactId or fields.email/);
    assert.equal(hubSpotSync.status, 400);
    assert.match(hubSpotSync.data.error, /hubspotContactId or properties.email/);
    assert.equal(form.status, 400);
    assert.match(form.data.error, /fields.email or email/);
  });
});

test("POST /api/forms/wix-submission with valid API key creates a form submission and sync event", async () => {
  await withTestApp(async ({ request }) => {
    const { status, data } = await postJson(request, "/api/forms/wix-submission", {
      formId: "contact-us",
      wixContactId: "wix_form_test",
      syncId: "form_sync_001",
      updatedAt: "2026-05-28T10:00:00.000Z",
      pageUrl: "https://example.com/contact",
      utm_source: "google",
      fields: {
        email: "lead@example.com",
        firstName: "Lead"
      }
    });
    const state = await getState(request);

    assert.equal(status, 200);
    assert.equal(data.submission.formId, "contact-us");
    assert.match(data.event.message, /Captured Wix form submission/);
    assert.equal(state.formSubmissions.length, 1);
    assert.equal(state.syncEvents.length, 1);
    assert.equal(state.mockHubSpotContacts.length, 1);
  });
});

test("GET /api/reviewer/evidence summarizes sync proof without exposing tokens", async () => {
  await withTestApp(async ({ request }) => {
    await postJson(request, "/api/sync/wix-contact", {
      wixContactId: "wix_evidence",
      syncId: "evidence_wix",
      updatedAt: "2026-05-28T10:00:00.000Z",
      fields: { email: "evidence@example.com", firstName: "Evidence" }
    });
    await postJson(request, "/api/sync/hubspot-contact", {
      hubspotContactId: "hs_evidence",
      syncId: "evidence_hs",
      updatedAt: "2026-05-28T10:05:00.000Z",
      properties: { email: "hubspot-evidence@example.com", firstname: "HubSpot" }
    });
    await postJson(request, "/api/forms/wix-submission", {
      formId: "evidence-form",
      syncId: "evidence_form",
      fields: { email: "form-evidence@example.com", firstName: "Form" },
      utm_source: "review"
    });

    const evidence = await request({ path: "/api/reviewer/evidence" });

    assert.equal(evidence.status, 200);
    assert.equal(evidence.data.checklist.wixContactReachedHubSpot, true);
    assert.equal(evidence.data.checklist.hubspotReachedWix, true);
    assert.equal(evidence.data.checklist.wixFormAttributionCaptured, true);
    assert.equal(evidence.data.checklist.stateTokenExposureCheckPassed, true);
    assert.doesNotMatch(JSON.stringify(evidence.data), /accessToken|refreshToken/);
  });
});

test("same-source stale Wix replay with different syncId is skipped through the API", async () => {
  await withTestApp(async ({ request }) => {
    await postJson(request, "/api/sync/wix-contact", {
      wixContactId: "wix_api_stale",
      syncId: "wix_api_newer",
      updatedAt: "2026-05-28T10:10:00.000Z",
      fields: { email: "wix-api-stale@example.com", firstName: "Newer" }
    });
    const stale = await postJson(request, "/api/sync/wix-contact", {
      wixContactId: "wix_api_stale",
      syncId: "wix_api_older",
      updatedAt: "2026-05-28T10:00:00.000Z",
      fields: { email: "wix-api-stale@example.com", firstName: "Older" }
    });

    assert.equal(stale.status, 200);
    assert.equal(stale.data.event.status, "skipped");
    assert.match(stale.data.event.message, /newer Wix timestamp/);
  });
});

test("same-source stale HubSpot replay with different syncId is skipped through the API", async () => {
  await withTestApp(async ({ request }) => {
    await postJson(request, "/api/sync/hubspot-contact", {
      hubspotContactId: "hs_api_stale",
      syncId: "hs_api_newer",
      updatedAt: "2026-05-28T10:10:00.000Z",
      properties: { email: "hs-api-stale@example.com", firstname: "Newer" }
    });
    const stale = await postJson(request, "/api/sync/hubspot-contact", {
      hubspotContactId: "hs_api_stale",
      syncId: "hs_api_older",
      updatedAt: "2026-05-28T10:00:00.000Z",
      properties: { email: "hs-api-stale@example.com", firstname: "Older" }
    });

    assert.equal(stale.status, 200);
    assert.equal(stale.data.event.status, "skipped");
    assert.match(stale.data.event.message, /newer HubSpot timestamp/);
  });
});

test("duplicate processed syncId is skipped through the API", async () => {
  await withTestApp(async ({ request }) => {
    await postJson(request, "/api/sync/wix-contact", {
      wixContactId: "wix_api_duplicate",
      syncId: "duplicate_sync",
      updatedAt: "2026-05-28T10:00:00.000Z",
      fields: { email: "duplicate-api@example.com", firstName: "Original" }
    });
    await postJson(request, "/api/sync/wix-contact", {
      wixContactId: "wix_api_duplicate",
      syncId: "newer_sync",
      updatedAt: "2026-05-28T10:05:00.000Z",
      fields: { email: "duplicate-api@example.com", firstName: "Newer" }
    });
    const duplicate = await postJson(request, "/api/sync/wix-contact", {
      wixContactId: "wix_api_duplicate",
      syncId: "duplicate_sync",
      updatedAt: "2026-05-28T10:10:00.000Z",
      fields: { email: "duplicate-api@example.com", firstName: "Duplicate" }
    });

    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.data.event.status, "skipped");
    assert.match(duplicate.data.event.message, /duplicate Wix event/);
  });
});

test("real HubSpot OAuth connect and callback exchange code without exposing tokens", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wix-hubspot-test-"));
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    assert.match(String(url), /oauth\/v1\/token/);
    assert.equal(options.method, "POST");
    return new Response(
      JSON.stringify({
        access_token: "hs-access-token",
        refresh_token: "hs-refresh-token",
        expires_in: 1800,
        hub_id: 12345
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  const handleRequest = createRequestHandler({
    dbPath: join(dir, "app-db.sqlite"),
    webhookApiKey: API_KEY,
    appBaseUrl: "http://127.0.0.1",
    hubspotMode: "real",
    env: {
      WIX_APP_SECRET,
      TOKEN_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      HUBSPOT_CLIENT_ID: "client-id",
      HUBSPOT_CLIENT_SECRET: "client-secret",
      HUBSPOT_REDIRECT_URI: "http://127.0.0.1/api/auth/hubspot/callback"
    }
  });

  try {
    const wixToken = signedWixToken({ siteId: "site_1", installId: "install_1" });
    const connect = await request(handleRequest, {
      method: "POST",
      path: "/api/auth/hubspot/connect",
      body: { siteId: "site_1", installId: "install_1" },
      headers: { authorization: `Bearer ${wixToken}` }
    });
    const state = new URL(connect.data.redirectUrl).searchParams.get("state");
    const callback = await request(handleRequest, {
      path: `/api/auth/hubspot/callback?code=demo-code&state=${state}`,
      apiKey: null
    });
    const appState = await request(handleRequest, { path: "/api/state", apiKey: null });
    const signedState = await request(handleRequest, {
      path: "/api/state",
      apiKey: null,
      headers: { authorization: `Bearer ${wixToken}` }
    });

    assert.equal(connect.status, 200);
    assert.equal(callback.status, 302);
    assert.equal(appState.data.error, "A signed Wix instance/app token is required for this route in real mode.");
    assert.equal(signedState.data.connection.connected, true);
    assert.equal(signedState.data.connection.portalId, 12345);
    assert.equal(signedState.data.connection.tokens, undefined);
    assert.equal(signedState.data.webhookRegistrations[0].status, "polling-fallback");
    assert.doesNotMatch(JSON.stringify(signedState.data), /hs-access-token|hs-refresh-token/);

    const { DatabaseSync } = require("node:sqlite");
    const database = new DatabaseSync(join(dir, "app-db.sqlite"));
    const stored = database.prepare("SELECT data FROM hubspot_connections WHERE site_id = ?").get("site_1").data;
    database.close();
    assert.match(stored, /"storage":"encrypted"/);
    assert.doesNotMatch(stored, /hs-access-token|hs-refresh-token/);
  } finally {
    global.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real Wix install stores site access token encrypted and never exposes it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wix-hubspot-test-"));
  const handleRequest = createRequestHandler({
    dbPath: join(dir, "app-db.sqlite"),
    webhookApiKey: API_KEY,
    appBaseUrl: "http://127.0.0.1",
    hubspotMode: "real",
    env: {
      WIX_APP_SECRET,
      WIX_ACCESS_TOKEN: "wix-site-token",
      TOKEN_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    }
  });

  try {
    const wixToken = signedWixToken({ siteId: "site_install", installId: "install_install" });
    const installed = await request(handleRequest, {
      method: "POST",
      path: "/api/auth/wix/install",
      body: {},
      apiKey: null,
      headers: { authorization: `Bearer ${wixToken}` }
    });
    const state = await request(handleRequest, {
      path: "/api/state",
      apiKey: null,
      headers: { authorization: `Bearer ${wixToken}` }
    });

    assert.equal(installed.status, 200);
    assert.equal(installed.data.installed, true);
    assert.equal(state.data.connection.siteId, "site_install");
    assert.equal(state.data.connection.wixAccessToken, undefined);
    assert.doesNotMatch(JSON.stringify(state.data), /wix-site-token/);

    const { DatabaseSync } = require("node:sqlite");
    const database = new DatabaseSync(join(dir, "app-db.sqlite"));
    const stored = database.prepare("SELECT data FROM hubspot_connections WHERE site_id = ?").get("site_install").data;
    database.close();
    assert.match(stored, /"wixAccessToken":\{"storage":"encrypted"/);
    assert.doesNotMatch(stored, /wix-site-token/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real Wix install uses native OAuth client credentials and rejects cross-site state access", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wix-hubspot-test-"));
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    assert.equal(String(url), "https://www.wixapis.com/oauth2/token");
    const body = JSON.parse(options.body);
    assert.equal(body.grant_type, "client_credentials");
    assert.equal(body.client_id, "wix-app-id");
    assert.equal(body.client_secret, WIX_APP_SECRET);
    assert.equal(body.instance_id, "install_native");
    return new Response(
      JSON.stringify({
        body: JSON.stringify({
          access_token: "native-wix-access",
          expires_in: 14400
        })
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  const handleRequest = createRequestHandler({
    dbPath: join(dir, "app-db.sqlite"),
    webhookApiKey: API_KEY,
    appBaseUrl: "http://127.0.0.1",
    wixMode: "real",
    env: {
      WIX_APP_ID: "wix-app-id",
      WIX_APP_SECRET,
      TOKEN_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    }
  });

  try {
    const wixToken = signedWixToken({ siteId: "site_native", installId: "install_native" });
    const otherSiteToken = signedWixToken({ siteId: "site_other", installId: "install_native" });
    const installed = await request(handleRequest, {
      method: "POST",
      path: "/api/auth/wix/install",
      body: {},
      apiKey: null,
      headers: { authorization: `Bearer ${wixToken}` }
    });
    const denied = await request(handleRequest, {
      path: "/api/state",
      apiKey: null,
      headers: { authorization: `Bearer ${otherSiteToken}` }
    });

    assert.equal(installed.status, 200);
    assert.equal(installed.data.wixTokenExpiresAt !== null, true);
    assert.equal(denied.status, 403);
    assert.match(denied.data.error, /Wix site/);
  } finally {
    global.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real mode isolates mappings and state by Wix site", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wix-hubspot-test-"));
  const handleRequest = createRequestHandler({
    dbPath: join(dir, "app-db.sqlite"),
    webhookApiKey: API_KEY,
    appBaseUrl: "http://127.0.0.1",
    wixMode: "real",
    env: {
      WIX_APP_SECRET,
      WIX_ACCESS_TOKEN: "shared-review-token",
      TOKEN_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    }
  });

  try {
    const siteAToken = signedWixToken({ siteId: "site_a", installId: "install_a" });
    const siteBToken = signedWixToken({ siteId: "site_b", installId: "install_b" });
    await request(handleRequest, {
      method: "POST",
      path: "/api/auth/wix/install",
      body: {},
      apiKey: null,
      headers: { authorization: `Bearer ${siteAToken}` }
    });
    await request(handleRequest, {
      method: "POST",
      path: "/api/auth/wix/install",
      body: {},
      apiKey: null,
      headers: { authorization: `Bearer ${siteBToken}` }
    });

    await request(handleRequest, {
      method: "POST",
      path: "/api/mappings",
      body: {
        mappings: [
          {
            wixField: "email",
            hubspotProperty: "email",
            direction: "bidirectional",
            transform: "lowercase"
          },
          {
            wixField: "firstName",
            hubspotProperty: "firstname_site_a",
            direction: "wix-to-hubspot",
            transform: "trim"
          }
        ]
      },
      apiKey: null,
      headers: { authorization: `Bearer ${siteAToken}` }
    });

    const siteAState = await request(handleRequest, {
      path: "/api/state",
      apiKey: null,
      headers: { authorization: `Bearer ${siteAToken}` }
    });
    const siteBState = await request(handleRequest, {
      path: "/api/state",
      apiKey: null,
      headers: { authorization: `Bearer ${siteBToken}` }
    });

    assert.equal(siteAState.status, 200);
    assert.equal(siteBState.status, 200);
    assert.equal(siteAState.data.connection.siteId, "site_a");
    assert.equal(siteBState.data.connection.siteId, "site_b");
    assert.equal(siteAState.data.mappings.some((mapping) => mapping.hubspotProperty === "firstname_site_a"), true);
    assert.equal(siteBState.data.mappings.some((mapping) => mapping.hubspotProperty === "firstname_site_a"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SQLite store migrates legacy single-key mapping tables for multiple sites", () => {
  const dir = mkdtempSync(join(tmpdir(), "wix-hubspot-test-"));
  const dbPath = join(dir, "legacy.sqlite");
  const { DatabaseSync } = require("node:sqlite");
  const database = new DatabaseSync(dbPath);
  database.exec(`
    CREATE TABLE field_mappings (
      id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL,
      wix_field TEXT NOT NULL,
      hubspot_property TEXT NOT NULL,
      direction TEXT NOT NULL,
      transform TEXT NOT NULL
    );
    INSERT INTO field_mappings VALUES ('map_email', 'default-site', 'email', 'email', 'bidirectional', 'lowercase');
  `);
  database.close();

  try {
    const initialDb = () => ({
      connection: {
        connected: false,
        mode: "real",
        siteId: "default-site",
        installId: "default-installation",
        portalId: null,
        tokens: null
      },
      installations: [],
      mappings: [
        {
          id: "map_email",
          wixField: "email",
          hubspotProperty: "email",
          direction: "bidirectional",
          transform: "lowercase"
        }
      ],
      contactMappings: [],
      processedEvents: [],
      oauthStates: [],
      webhookRegistrations: [],
      pollingCheckpoints: [],
      retryJobs: [],
      syncEvents: [],
      formSubmissions: [],
      mockHubSpotContacts: [],
      mockWixContacts: []
    });
    const store = createSqliteStore(dbPath, initialDb);
    const siteB = initialDb();
    siteB.connection.siteId = "site_b";
    siteB.connection.installId = "install_b";

    store.write(siteB);

    assert.equal(store.read("default-site").mappings[0].hubspotProperty, "email");
    assert.equal(store.read("site_b").mappings[0].hubspotProperty, "email");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real Wix disconnect clears stored Wix credentials without exposing them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wix-hubspot-test-"));
  const wixToken = signedWixToken({ siteId: "site_disconnect", installId: "install_disconnect" });
  const handleRequest = createRequestHandler({
    dbPath: join(dir, "app-db.sqlite"),
    webhookApiKey: API_KEY,
    appBaseUrl: "http://127.0.0.1",
    wixMode: "real",
    env: {
      WIX_APP_SECRET,
      WIX_ACCESS_TOKEN: "wix-disconnect-token",
      TOKEN_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    }
  });

  try {
    await request(handleRequest, {
      method: "POST",
      path: "/api/auth/wix/install",
      body: {},
      apiKey: null,
      headers: { authorization: `Bearer ${wixToken}` }
    });
    const disconnected = await request(handleRequest, {
      method: "POST",
      path: "/api/auth/wix/disconnect",
      body: {},
      apiKey: null,
      headers: { authorization: `Bearer ${wixToken}` }
    });
    const state = await request(handleRequest, {
      path: "/api/state",
      apiKey: null,
      headers: { authorization: `Bearer ${wixToken}` }
    });

    assert.equal(disconnected.status, 200);
    assert.equal(disconnected.data.installed, false);
    assert.equal(state.data.connection.wixTokenExpiresAt, null);
    assert.equal(state.data.installations.length, 0);
    assert.doesNotMatch(JSON.stringify(state.data), /wix-disconnect-token/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HubSpot polling fallback persists checkpoint and syncs changed contacts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wix-hubspot-test-"));
  const wixToken = signedWixToken({ siteId: "site_poll", installId: "install_poll" });
  const handleRequest = createRequestHandler({
    dbPath: join(dir, "app-db.sqlite"),
    webhookApiKey: API_KEY,
    appBaseUrl: "http://127.0.0.1",
    hubspotMode: "real",
    env: { WIX_APP_SECRET },
    adapters: {
      hubspot: {
        upsertContact() {
          throw new Error("Unexpected upsert.");
        },
        async listContactProperties() {
          return [];
        },
        async pollUpdatedContacts(_db, options) {
          assert.equal(options.since, "2026-05-28T10:00:00.000Z");
          return [
            {
              id: "hs_poll_1",
              updatedAt: "2026-05-28T10:05:00.000Z",
              properties: {
                email: "poll@example.com",
                firstname: "Polly",
                lastmodifieddate: "2026-05-28T10:05:00.000Z"
              }
            }
          ];
        }
      },
      wix: {
        async upsertContact(_db, fields) {
          return { contact: { id: "wix_poll_1", fields }, action: "created" };
        },
        async listContactFields() {
          return [];
        }
      }
    }
  });

  try {
    const result = await request(handleRequest, {
      method: "POST",
      path: "/api/poll/hubspot",
      body: { since: "2026-05-28T10:00:00.000Z" },
      apiKey: null,
      headers: { authorization: `Bearer ${wixToken}` }
    });
    const state = await request(handleRequest, {
      path: "/api/state",
      apiKey: null,
      headers: { authorization: `Bearer ${wixToken}` }
    });

    assert.equal(result.status, 200);
    assert.equal(result.data.checkpoint.status, "success");
    assert.equal(result.data.checkpoint.lastSeenModifiedAt, "2026-05-28T10:05:00.000Z");
    assert.match(result.data.events[0].message, /Wix contact/);
    assert.equal(state.data.pollingCheckpoints[0].lastModifiedAfter, "2026-05-28T10:00:00.000Z");
    assert.equal(state.data.contactMappings[0].hubspotContactId, "hs_poll_1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HubSpot polling fallback processes multiple pages before advancing checkpoint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wix-hubspot-test-"));
  const wixToken = signedWixToken({ siteId: "site_poll_pages", installId: "install_poll_pages" });
  const pages = [];
  const handleRequest = createRequestHandler({
    dbPath: join(dir, "app-db.sqlite"),
    webhookApiKey: API_KEY,
    appBaseUrl: "http://127.0.0.1",
    hubspotMode: "real",
    env: { WIX_APP_SECRET },
    adapters: {
      hubspot: {
        async pollUpdatedContacts(_db, options) {
          pages.push(options.after || "first");
          if (!options.after) {
            return {
              contacts: [
                {
                  id: "hs_poll_page_1",
                  updatedAt: "2026-05-28T10:05:00.000Z",
                  properties: { email: "page1@example.com", firstname: "Page", lastmodifieddate: "2026-05-28T10:05:00.000Z" }
                }
              ],
              nextAfter: "cursor_2",
              hasMore: true
            };
          }
          return {
            contacts: [
              {
                id: "hs_poll_page_2",
                updatedAt: "2026-05-28T10:10:00.000Z",
                properties: { email: "page2@example.com", firstname: "Second", lastmodifieddate: "2026-05-28T10:10:00.000Z" }
              }
            ],
            nextAfter: null,
            hasMore: false
          };
        }
      },
      wix: {
        async upsertContact(_db, fields) {
          return { contact: { id: `wix_${fields.email}`, fields }, action: "created" };
        }
      }
    }
  });

  try {
    const result = await request(handleRequest, {
      method: "POST",
      path: "/api/poll/hubspot",
      body: { since: "2026-05-28T10:00:00.000Z" },
      apiKey: null,
      headers: { authorization: `Bearer ${wixToken}` }
    });
    const state = await request(handleRequest, {
      path: "/api/state",
      apiKey: null,
      headers: { authorization: `Bearer ${wixToken}` }
    });

    assert.equal(result.status, 200);
    assert.deepEqual(pages, ["first", "cursor_2"]);
    assert.equal(result.data.events.length, 2);
    assert.equal(result.data.checkpoint.nextAfter, null);
    assert.equal(result.data.checkpoint.lastSeenModifiedAt, "2026-05-28T10:10:00.000Z");
    assert.equal(state.data.contactMappings.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HubSpot polling failure does not advance lastSeen checkpoint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wix-hubspot-test-"));
  const wixToken = signedWixToken({ siteId: "site_poll_fail", installId: "install_poll_fail" });
  const handleRequest = createRequestHandler({
    dbPath: join(dir, "app-db.sqlite"),
    webhookApiKey: API_KEY,
    appBaseUrl: "http://127.0.0.1",
    hubspotMode: "real",
    env: { WIX_APP_SECRET },
    adapters: {
      hubspot: {
        async pollUpdatedContacts() {
          return {
            contacts: [
              {
                id: "hs_poll_fail",
                updatedAt: "2026-05-28T10:05:00.000Z",
                properties: { email: "fail@example.com", firstname: "Fail", lastmodifieddate: "2026-05-28T10:05:00.000Z" }
              }
            ],
            nextAfter: "cursor_not_processed",
            hasMore: true
          };
        }
      },
      wix: {
        async upsertContact(_db, fields) {
          return { contact: { id: `wix_${fields.email}`, fields }, action: "created" };
        }
      }
    }
  });

  try {
    const failed = await request(handleRequest, {
      method: "POST",
      path: "/api/poll/hubspot",
      body: { since: "2026-05-28T10:00:00.000Z", maxPages: 1 },
      apiKey: null,
      headers: { authorization: `Bearer ${wixToken}` }
    });
    const state = await request(handleRequest, {
      path: "/api/state",
      apiKey: null,
      headers: { authorization: `Bearer ${wixToken}` }
    });

    assert.equal(failed.status, 429);
    assert.equal(state.data.pollingCheckpoints[0].status, "failed");
    assert.equal(state.data.pollingCheckpoints[0].lastSeenModifiedAt, null);
    assert.equal(state.data.pollingCheckpoints[0].nextAfter, "cursor_not_processed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("signed HubSpot contact webhook updates Wix", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wix-hubspot-test-"));
  const handleRequest = createRequestHandler({
    dbPath: join(dir, "app-db.sqlite"),
    webhookApiKey: API_KEY,
    appBaseUrl: "http://127.0.0.1",
    env: { HUBSPOT_CLIENT_SECRET: "hubspot-secret" }
  });

  try {
    const body = JSON.stringify([
      {
        eventId: "hs_webhook_1",
        objectId: "hs_webhook_contact",
        occurredAt: "2026-05-28T10:00:00.000Z",
        properties: { email: "hs-webhook@example.com", firstname: "HubSpot" }
      }
    ]);
    const timestamp = String(Date.now());
    const source = `POST${new URL("/api/webhooks/hubspot-contact", "http://127.0.0.1").toString()}${body}${timestamp}`;
    const signature = crypto.createHmac("sha256", "hubspot-secret").update(source).digest("base64");
    const result = await request(handleRequest, {
      method: "POST",
      path: "/api/webhooks/hubspot-contact",
      rawBody: body,
      apiKey: null,
      headers: {
        "x-hubspot-request-timestamp": timestamp,
        "x-hubspot-signature-v3": signature
      }
    });
    const state = await getState(request.bind(null, handleRequest));

    assert.equal(result.status, 200);
    assert.equal(state.mockWixContacts.length, 1);
    assert.match(result.data.events[0].message, /Wix contact/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("signed HubSpot property-change webhook hydrates the full contact before syncing to Wix", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wix-hubspot-test-"));
  const handleRequest = createRequestHandler({
    dbPath: join(dir, "app-db.sqlite"),
    webhookApiKey: API_KEY,
    appBaseUrl: "http://127.0.0.1",
    env: { HUBSPOT_CLIENT_SECRET: "hubspot-secret" },
    adapters: {
      hubspot: {
        async getContact(_db, hubspotContactId) {
          assert.equal(hubspotContactId, "hs_partial_webhook");
          return {
            id: "hs_partial_webhook",
            updatedAt: "2026-05-28T10:10:00.000Z",
            properties: {
              email: "hydrated@example.com",
              firstname: "Hydrated",
              lastname: "Contact"
            }
          };
        }
      },
      wix: {
        async upsertContact(_db, fields) {
          assert.equal(fields.email, "hydrated@example.com");
          assert.equal(fields.firstName, "Changed");
          assert.equal(fields.lastName, "Contact");
          return { contact: { id: "wix_hydrated", fields }, action: "updated" };
        }
      }
    }
  });

  try {
    const body = JSON.stringify([
      {
        eventId: "hs_partial_1",
        objectId: "hs_partial_webhook",
        occurredAt: "2026-05-28T10:00:00.000Z",
        propertyName: "firstname",
        propertyValue: "Changed"
      }
    ]);
    const timestamp = String(Date.now());
    const source = `POST${new URL("/api/webhooks/hubspot-contact", "http://127.0.0.1").toString()}${body}${timestamp}`;
    const signature = crypto.createHmac("sha256", "hubspot-secret").update(source).digest("base64");
    const result = await request(handleRequest, {
      method: "POST",
      path: "/api/webhooks/hubspot-contact",
      rawBody: body,
      apiKey: null,
      headers: {
        "x-hubspot-request-timestamp": timestamp,
        "x-hubspot-signature-v3": signature
      }
    });

    assert.equal(result.status, 200);
    assert.match(result.data.events[0].message, /Wix contact/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("signed Wix contact webhook updates HubSpot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wix-hubspot-test-"));
  const handleRequest = createRequestHandler({
    dbPath: join(dir, "app-db.sqlite"),
    webhookApiKey: API_KEY,
    appBaseUrl: "http://127.0.0.1",
    env: { WIX_WEBHOOK_SECRET: "wix-secret" }
  });

  try {
    const body = JSON.stringify({
      eventId: "wix_contact_webhook_1",
      data: {
        contactId: "wix_webhook_contact",
        updatedAt: "2026-05-28T10:00:00.000Z",
        fields: { email: "wix-webhook@example.com", firstName: "Wix" }
      }
    });
    const signature = crypto.createHmac("sha256", "wix-secret").update(body).digest("base64");
    const result = await request(handleRequest, {
      method: "POST",
      path: "/api/webhooks/wix-contact",
      rawBody: body,
      apiKey: null,
      headers: { "x-wix-signature": signature }
    });
    const state = await getState(request.bind(null, handleRequest));

    assert.equal(result.status, 200);
    assert.equal(state.mockHubSpotContacts.length, 1);
    assert.match(result.data.event.message, /HubSpot contact/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real HubSpot adapter refreshes token, searches by email, and creates contact", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("/oauth/v1/token")) {
      return new Response(
        JSON.stringify({ access_token: "fresh-access", refresh_token: "refresh-token", expires_in: 1800 }),
        { status: 200 }
      );
    }
    if (String(url).endsWith("/crm/v3/objects/contacts/search")) {
      assert.equal(options.headers.authorization, "Bearer fresh-access");
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (String(url).endsWith("/crm/v3/objects/contacts")) {
      return new Response(JSON.stringify({ id: "hs_created", properties: { email: "new@example.com" } }), {
        status: 201
      });
    }
    throw new Error(`Unexpected URL ${url}`);
  };

  try {
    const db = {
      connection: {
        connected: true,
        tokens: {
          accessToken: "expired-access",
          refreshToken: "refresh-token",
          expiresAt: "2020-01-01T00:00:00.000Z"
        }
      }
    };
    const adapter = createRealHubSpotAdapter({
      HUBSPOT_CLIENT_ID: "client-id",
      HUBSPOT_CLIENT_SECRET: "client-secret",
      HUBSPOT_API_BASE_URL: "https://api.hubapi.com",
      HUBSPOT_OAUTH_BASE_URL: "https://api.hubapi.com"
    });

    const result = await adapter.upsertContact(db, { email: "new@example.com" });

    assert.equal(result.action, "created");
    assert.equal(result.contact.id, "hs_created");
    assert.equal(db.connection.tokens.accessToken, "fresh-access");
    assert.equal(calls.length, 3);
  } finally {
    global.fetch = originalFetch;
  }
});

test("real Wix adapter creates a contact through Wix Contacts API", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (String(url).includes("/contacts/v4/contacts/query")) {
      assert.equal(options.headers.authorization, "Bearer wix-token");
      return new Response(JSON.stringify({ contacts: [] }), { status: 200 });
    }
    if (String(url).endsWith("/contacts/v4/contacts")) {
      return new Response(
        JSON.stringify({ contact: { id: "wix_created", info: { emails: [{ email: "lead@example.com" }] } } }),
        { status: 200 }
      );
    }
    throw new Error(`Unexpected URL ${url}`);
  };

  try {
    const adapter = createRealWixAdapter({ WIX_ACCESS_TOKEN: "wix-token", WIX_API_BASE_URL: "https://www.wixapis.com" });
    const result = await adapter.upsertContact({ connection: { siteId: "site_1" } }, { email: "lead@example.com" });

    assert.equal(result.action, "created");
    assert.equal(result.contact.id, "wix_created");
  } finally {
    global.fetch = originalFetch;
  }
});

test("real Wix adapter refreshes expired OAuth access token before API calls", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/oauth2/token")) {
      const body = JSON.parse(options.body);
      assert.equal(body.instance_id, "install_refresh");
      return new Response(JSON.stringify({ access_token: "fresh-wix-access", expires_in: 14400 }), { status: 200 });
    }
    if (String(url).includes("/contacts/v4/contacts/query")) {
      assert.equal(options.headers.authorization, "Bearer fresh-wix-access");
      return new Response(JSON.stringify({ contacts: [] }), { status: 200 });
    }
    if (String(url).endsWith("/contacts/v4/contacts")) {
      return new Response(
        JSON.stringify({ contact: { id: "wix_refresh_created", info: { emails: [{ email: "refresh@example.com" }] } } }),
        { status: 200 }
      );
    }
    throw new Error(`Unexpected URL ${url}`);
  };

  try {
    const db = {
      connection: {
        siteId: "site_refresh",
        installId: "install_refresh",
        wixAccessToken: "expired-wix-access",
        wixTokenExpiresAt: "2020-01-01T00:00:00.000Z"
      }
    };
    const adapter = createRealWixAdapter({
      WIX_APP_ID: "wix-app-id",
      WIX_APP_SECRET: "wix-app-secret",
      WIX_API_BASE_URL: "https://www.wixapis.com",
      WIX_OAUTH_BASE_URL: "https://www.wixapis.com"
    });
    const result = await adapter.upsertContact(db, { email: "refresh@example.com" });

    assert.equal(result.action, "created");
    assert.equal(db.connection.wixAccessToken, "fresh-wix-access");
    assert.equal(calls.length, 3);
  } finally {
    global.fetch = originalFetch;
  }
});

test("signed Wix form webhook syncs attribution to HubSpot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wix-hubspot-test-"));
  const handleRequest = createRequestHandler({
    dbPath: join(dir, "app-db.json"),
    webhookApiKey: API_KEY,
    appBaseUrl: "http://127.0.0.1",
    env: { WIX_WEBHOOK_SECRET: "wix-secret" }
  });

  try {
    const body = JSON.stringify({
      eventId: "wix_form_signed_1",
      data: {
        formId: "contact",
        submittedAt: "2026-05-28T10:00:00.000Z",
        pageUrl: "https://example.com/contact",
        referrer: "https://google.com",
        utm_source: "google",
        utm_medium: "cpc",
        utm_campaign: "launch",
        utm_term: "crm",
        utm_content: "ad-a",
        fields: { email: "signed-form@example.com", firstName: "Signed" }
      }
    });
    const signature = crypto.createHmac("sha256", "wix-secret").update(body).digest("base64");
    const result = await request(handleRequest, {
      method: "POST",
      path: "/api/webhooks/wix-form",
      rawBody: body,
      apiKey: null
    });

    assert.equal(result.status, 401);

    const signed = await request(handleRequest, {
      method: "POST",
      path: "/api/webhooks/wix-form",
      rawBody: body,
      apiKey: null,
      headers: { "x-wix-signature": signature }
    });
    const state = await getState(request.bind(null, handleRequest));

    assert.equal(signed.status, 200);
    assert.equal(state.formSubmissions.length, 1);
    assert.equal(state.mockHubSpotContacts[0].properties.wix_utm_source, "google");
    assert.equal(state.mockHubSpotContacts[0].properties.wix_utm_content, "ad-a");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
