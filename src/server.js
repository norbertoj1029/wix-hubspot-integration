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
const defaultDbPath = join(dataDir, "app-db.json");

const port = Number(process.env.PORT || 3000);
const appBaseUrl = process.env.APP_BASE_URL || `http://localhost:${port}`;
const hubspotMode = process.env.HUBSPOT_MODE || "mock";
const webhookApiKey = process.env.WEBHOOK_API_KEY || "dev-webhook-secret";
const protectedRoutes = new Set([
  "/api/auth/hubspot/connect",
  "/api/auth/hubspot/disconnect",
  "/api/mappings",
  "/api/sync/wix-contact",
  "/api/sync/hubspot-contact",
  "/api/forms/wix-submission"
]);

function initialDb(mode = hubspotMode) {
  return {
    connection: {
      connected: false,
      mode,
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

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store"
  });
  res.end(body);
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function validateMappingsPayload(body) {
  if (!Array.isArray(body.mappings) || body.mappings.length === 0) {
    return "Request body must include at least one mapping.";
  }
  return null;
}

function validateWixContactPayload(body) {
  if (hasValue(body.wixContactId) || hasValue(body.fields?.email)) return null;
  return "Wix contact sync requires wixContactId or fields.email.";
}

function validateHubSpotContactPayload(body) {
  if (hasValue(body.hubspotContactId) || hasValue(body.properties?.email)) return null;
  return "HubSpot contact sync requires hubspotContactId or properties.email.";
}

function validateWixFormPayload(body) {
  if (hasValue(body.fields?.email) || hasValue(body.email)) return null;
  return "Wix form submission requires fields.email or email.";
}

function timingSafeEqual(left, right) {
  const leftBuffer = Buffer.from(left || "");
  const rightBuffer = Buffer.from(right || "");
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function isAuthorizedWebhook(req, apiKey = webhookApiKey) {
  const headerKey = req.headers["x-webhook-api-key"];
  const authHeader = req.headers.authorization || "";
  const bearerKey = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
  return timingSafeEqual(headerKey, apiKey) || timingSafeEqual(bearerKey, apiKey);
}

const sensitiveKeys = new Set([
  "email",
  "firstname",
  "firstName",
  "lastname",
  "lastName",
  "phone",
  "company"
]);

function redactSensitive(value) {
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, childValue]) => [
      key,
      sensitiveKeys.has(key) ? "[redacted]" : redactSensitive(childValue)
    ])
  );
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

function serveStatic(req, res, baseUrl = appBaseUrl) {
  const url = new URL(req.url, baseUrl);
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

async function routeApi(req, res, { store, baseUrl, mode, apiKey }) {
  const url = new URL(req.url, baseUrl);
  const db = store.read();

  if (protectedRoutes.has(url.pathname) && !isAuthorizedWebhook(req, apiKey)) {
    return sendJson(res, 401, { error: "Missing or invalid webhook API key." });
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    return sendJson(res, 200, {
      connection: db.connection,
      mappings: db.mappings,
      contactMappings: db.contactMappings,
      syncEvents: redactSensitive(db.syncEvents),
      formSubmissions: redactSensitive(db.formSubmissions),
      mockHubSpotContacts: redactSensitive(db.mockHubSpotContacts),
      mockWixContacts: redactSensitive(db.mockWixContacts)
    });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/hubspot/connect") {
    if (mode === "real" && process.env.HUBSPOT_CLIENT_ID) {
      const params = new URLSearchParams({
        client_id: process.env.HUBSPOT_CLIENT_ID,
        redirect_uri: process.env.HUBSPOT_REDIRECT_URI || `${baseUrl}/api/auth/hubspot/callback`,
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
      mode,
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
      mode,
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
    const validationError = validateMappingsPayload(body);
    if (validationError) return sendJson(res, 400, { error: validationError });

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
    const validationError = validateWixContactPayload(body);
    if (validationError) return sendJson(res, 400, { error: validationError });

    const event = syncWixContactToHubSpot(db, body);
    store.write(db);
    return sendJson(res, 200, { event: redactSensitive(event) });
  }

  if (req.method === "POST" && url.pathname === "/api/sync/hubspot-contact") {
    const body = await readBody(req);
    const validationError = validateHubSpotContactPayload(body);
    if (validationError) return sendJson(res, 400, { error: validationError });

    const event = syncHubSpotContactToWix(db, body);
    store.write(db);
    return sendJson(res, 200, { event: redactSensitive(event) });
  }

  if (req.method === "POST" && url.pathname === "/api/forms/wix-submission") {
    const body = await readBody(req);
    const validationError = validateWixFormPayload(body);
    if (validationError) return sendJson(res, 400, { error: validationError });

    const attributionFields = {
      utm_source: body.utm_source,
      utm_medium: body.utm_medium,
      utm_campaign: body.utm_campaign,
      utm_term: body.utm_term,
      utm_content: body.utm_content,
      pageUrl: body.pageUrl,
      referrer: body.referrer
    };
    const submissionFields = {
      ...(body.fields || body),
      ...Object.fromEntries(Object.entries(attributionFields).filter(([, value]) => value !== undefined))
    };
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
      fields: submissionFields
    };
    db.formSubmissions.unshift(submission);
    db.formSubmissions = db.formSubmissions.slice(0, 50);
    const event = syncWixContactToHubSpot(db, {
      wixContactId: body.wixContactId,
      syncId: body.syncId,
      updatedAt: body.updatedAt,
      fields: submissionFields
    });
    event.message = "Captured Wix form submission and synced lead to HubSpot.";
    store.write(db);
    return sendJson(res, 200, { submission: redactSensitive(submission), event: redactSensitive(event) });
  }

  return sendJson(res, 404, { error: "API route not found" });
}

export function createRequestHandler(options = {}) {
  const serverPort = Number(options.port || port);
  const mode = options.hubspotMode || hubspotMode;
  const baseUrl = options.appBaseUrl || `http://localhost:${serverPort}`;
  const store = createJsonStore(options.dbPath || process.env.DB_PATH || defaultDbPath, () => initialDb(mode));
  const apiKey = options.webhookApiKey || webhookApiKey;

  return async function handleRequest(req, res) {
    try {
      if (req.url.startsWith("/api/")) return await routeApi(req, res, { store, baseUrl, mode, apiKey });
      return serveStatic(req, res, baseUrl);
    } catch (error) {
      const status = error.message === "Invalid JSON body" || error.message === "Request body too large" ? 400 : 500;
      return sendJson(res, status, { error: error.message || "Unexpected server error" });
    }
  };
}

export function createServer(options = {}) {
  return http.createServer(createRequestHandler(options));
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isEntrypoint) {
  const server = createServer({ port, appBaseUrl, hubspotMode, dbPath: process.env.DB_PATH || defaultDbPath });
  server.listen(port, () => {
    console.log(`Wix HubSpot integration running at ${appBaseUrl}`);
  });
}
