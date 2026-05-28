import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createRequestHandler } from "../src/server.js";

const API_KEY = "test-webhook-secret";

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

async function request(handleRequest, { method = "GET", path, body, rawBody, apiKey = API_KEY } = {}) {
  const requestBody = rawBody !== undefined ? rawBody : body === undefined ? "" : JSON.stringify(body);
  const req = Readable.from(requestBody ? [requestBody] : []);
  req.method = method;
  req.url = path;
  req.headers = body === undefined && rawBody === undefined ? {} : { "content-type": "application/json" };
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

test("real HubSpot OAuth callback returns 501 instead of pretending token exchange happened", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wix-hubspot-test-"));
  const handleRequest = createRequestHandler({
    dbPath: join(dir, "app-db.json"),
    webhookApiKey: API_KEY,
    appBaseUrl: "http://127.0.0.1",
    hubspotMode: "real",
    env: {}
  });

  try {
    const result = await request(handleRequest, {
      path: "/api/auth/hubspot/callback?code=demo-code",
      apiKey: null
    });

    assert.equal(result.status, 501);
    assert.match(result.data.error, /token exchange is not implemented/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real adapter placeholder fails gracefully when credentials are missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wix-hubspot-test-"));
  const handleRequest = createRequestHandler({
    dbPath: join(dir, "app-db.json"),
    webhookApiKey: API_KEY,
    appBaseUrl: "http://127.0.0.1",
    hubspotMode: "real",
    env: {}
  });

  try {
    const result = await request(handleRequest, {
      method: "POST",
      path: "/api/sync/wix-contact",
      body: {
        wixContactId: "wix_real_missing",
        fields: { email: "real@example.com" }
      }
    });

    assert.equal(result.status, 501);
    assert.match(result.data.error, /Real HubSpot adapter is not configured/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
