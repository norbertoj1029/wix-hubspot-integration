import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { defaultMappings } from "./config/defaultMappings.js";
import { createJsonStore } from "./storage/jsonStore.js";
import { id, now } from "./lib/time.js";
import { logEvent, syncHubSpotContactToWix, syncWixContactToHubSpot } from "./services/syncService.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const publicDir = join(rootDir, "public");
const dataDir = join(rootDir, "data");
const dbPath = join(dataDir, "app-db.json");

const port = Number(process.env.PORT || 3000);
const appBaseUrl = process.env.APP_BASE_URL || `http://localhost:${port}`;
const hubspotMode = process.env.HUBSPOT_MODE || "mock";
const webhookApiKey = process.env.WEBHOOK_API_KEY || "dev-webhook-secret";
const protectedRoutes = new Set([
  "/api/sync/wix-contact",
  "/api/sync/hubspot-contact",
  "/api/forms/wix-submission"
]);

function initialDb() {
  return {
    connection: {
      connected: false,
      mode: hubspotMode,
      portalId: null,
      connectedAt: null,
      disconnectedAt: null
    },
    mappings: defaultMappings,
    contactMappings: [],
    syncEvents: [],
    formSubmissions: [],
    mockHubSpotContacts: [],
    mockWixContacts: []
  };
}

const store = createJsonStore(dbPath, initialDb);

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store"
  });
  res.end(body);
}

function timingSafeEqual(left, right) {
  const leftBuffer = Buffer.from(left || "");
  const rightBuffer = Buffer.from(right || "");
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function isAuthorizedWebhook(req) {
  const headerKey = req.headers["x-webhook-api-key"];
  const authHeader = req.headers.authorization || "";
  const bearerKey = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
  return timingSafeEqual(headerKey, webhookApiKey) || timingSafeEqual(bearerKey, webhookApiKey);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
  });
}

function serveStatic(req, res) {
  const url = new URL(req.url, appBaseUrl);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = pathname.replaceAll("..", "");
  const filePath = join(publicDir, safePath);
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8"
  };

  try {
    const data = readFileSync(filePath);
    res.writeHead(200, { "content-type": types[extname(filePath)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

async function routeApi(req, res) {
  const url = new URL(req.url, appBaseUrl);
  const db = store.read();

  if (protectedRoutes.has(url.pathname) && !isAuthorizedWebhook(req)) {
    return sendJson(res, 401, { error: "Missing or invalid webhook API key." });
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    return sendJson(res, 200, {
      connection: db.connection,
      mappings: db.mappings,
      contactMappings: db.contactMappings,
      syncEvents: db.syncEvents,
      formSubmissions: db.formSubmissions,
      mockHubSpotContacts: db.mockHubSpotContacts,
      mockWixContacts: db.mockWixContacts,
      demoWebhookApiKey: webhookApiKey
    });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/hubspot/connect") {
    if (hubspotMode === "real" && process.env.HUBSPOT_CLIENT_ID) {
      const params = new URLSearchParams({
        client_id: process.env.HUBSPOT_CLIENT_ID,
        redirect_uri: process.env.HUBSPOT_REDIRECT_URI || `${appBaseUrl}/api/auth/hubspot/callback`,
        scope: "crm.objects.contacts.read crm.objects.contacts.write crm.schemas.contacts.read",
        response_type: "code"
      });
      return sendJson(res, 200, {
        mode: "real",
        redirectUrl: `https://app.hubspot.com/oauth/authorize?${params.toString()}`
      });
    }

    db.connection = {
      connected: true,
      mode: "mock",
      portalId: "demo-portal",
      connectedAt: now(),
      disconnectedAt: null
    };
    logEvent(db, {
      source: "system",
      syncId: id("corr"),
      message: "Connected HubSpot in mock mode.",
      details: { tokenStorage: "server-only placeholder" }
    });
    store.write(db);
    return sendJson(res, 200, { connected: true, mode: "mock" });
  }

  if (req.method === "GET" && url.pathname === "/api/auth/hubspot/callback") {
    db.connection = {
      connected: true,
      mode: hubspotMode,
      portalId: "pending-token-exchange",
      connectedAt: now(),
      disconnectedAt: null
    };
    logEvent(db, {
      source: "system",
      syncId: id("corr"),
      message: "Received HubSpot OAuth callback. Token exchange is documented for production setup.",
      details: { codeReceived: Boolean(url.searchParams.get("code")) }
    });
    store.write(db);
    res.writeHead(302, { location: "/" });
    return res.end();
  }

  if (req.method === "POST" && url.pathname === "/api/auth/hubspot/disconnect") {
    db.connection = {
      connected: false,
      mode: hubspotMode,
      portalId: null,
      connectedAt: db.connection.connectedAt,
      disconnectedAt: now()
    };
    logEvent(db, {
      source: "system",
      syncId: id("corr"),
      message: "Disconnected HubSpot and cleared active connection state.",
      details: {}
    });
    store.write(db);
    return sendJson(res, 200, { connected: false });
  }

  if (req.method === "POST" && url.pathname === "/api/mappings") {
    const body = await readBody(req);
    const hubspotProperties = new Set();
    for (const mapping of body.mappings || []) {
      if (!mapping.wixField || !mapping.hubspotProperty) {
        return sendJson(res, 400, { error: "Each mapping needs a Wix field and HubSpot property." });
      }
      if (hubspotProperties.has(mapping.hubspotProperty)) {
        return sendJson(res, 400, { error: `Duplicate HubSpot property: ${mapping.hubspotProperty}` });
      }
      hubspotProperties.add(mapping.hubspotProperty);
    }

    db.mappings = body.mappings.map((mapping) => ({
      id: mapping.id || id("map"),
      wixField: mapping.wixField,
      hubspotProperty: mapping.hubspotProperty,
      direction: mapping.direction,
      transform: mapping.transform
    }));
    logEvent(db, {
      source: "system",
      syncId: id("corr"),
      message: "Saved field mappings.",
      details: { count: db.mappings.length }
    });
    store.write(db);
    return sendJson(res, 200, { mappings: db.mappings });
  }

  if (req.method === "POST" && url.pathname === "/api/sync/wix-contact") {
    const body = await readBody(req);
    const event = syncWixContactToHubSpot(db, body);
    store.write(db);
    return sendJson(res, 200, { event });
  }

  if (req.method === "POST" && url.pathname === "/api/sync/hubspot-contact") {
    const body = await readBody(req);
    const event = syncHubSpotContactToWix(db, body);
    store.write(db);
    return sendJson(res, 200, { event });
  }

  if (req.method === "POST" && url.pathname === "/api/forms/wix-submission") {
    const body = await readBody(req);
    const submission = {
      id: id("form"),
      createdAt: now(),
      formId: body.formId || "demo-contact-form",
      pageUrl: body.pageUrl,
      referrer: body.referrer,
      utm: {
        source: body.utm_source,
        medium: body.utm_medium,
        campaign: body.utm_campaign,
        term: body.utm_term,
        content: body.utm_content
      },
      fields: body.fields || body
    };
    db.formSubmissions.unshift(submission);
    db.formSubmissions = db.formSubmissions.slice(0, 50);
    const event = syncWixContactToHubSpot(db, {
      wixContactId: body.wixContactId,
      syncId: body.syncId,
      fields: {
        ...(body.fields || body),
        pageUrl: body.pageUrl,
        referrer: body.referrer
      }
    });
    event.message = "Captured Wix form submission and synced lead to HubSpot.";
    store.write(db);
    return sendJson(res, 200, { submission, event });
  }

  return sendJson(res, 404, { error: "API route not found" });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/api/")) return await routeApi(req, res);
    return serveStatic(req, res);
  } catch (error) {
    return sendJson(res, 500, { error: error.message || "Unexpected server error" });
  }
});

server.listen(port, () => {
  console.log(`Wix HubSpot integration running at ${appBaseUrl}`);
});
