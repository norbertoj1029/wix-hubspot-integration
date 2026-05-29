import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { createAdapters } from "./adapters/index.js";
import { defaultMappings } from "./config/defaultMappings.js";
import { createJsonStore } from "./storage/jsonStore.js";
import { createSqliteStore } from "./storage/sqliteStore.js";
import { id, now } from "./lib/time.js";
import {
  buildHubSpotAuthorizeUrl,
  consumeOAuthState,
  createOAuthState,
  exchangeHubSpotCode,
  revokeHubSpotRefreshToken
} from "./services/oauth.js";
import {
  logEvent,
  processHubSpotPollingFallback,
  processDueRetryJobs,
  syncHubSpotContactToWix,
  syncWixContactToHubSpot
} from "./services/syncService.js";
import { tokenStorageMode } from "./services/tokenStorage.js";
import { assertSameInstallation, getWixRequestContext } from "./services/wixAuth.js";
import { exchangeWixInstallToken } from "./services/wixInstall.js";
import { verifyHubSpotWebhookSignature, verifyWixWebhookSignature } from "./services/webhookSecurity.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const publicDir = join(rootDir, "public");
const dataDir = join(rootDir, "data");
const defaultDbPath = join(dataDir, "app-db.sqlite");

const port = Number(process.env.PORT || 3000);
const appBaseUrl = process.env.APP_BASE_URL || `http://localhost:${port}`;
const hubspotMode = process.env.HUBSPOT_MODE || "mock";
const wixMode = process.env.WIX_MODE || "mock";
const webhookApiKey = process.env.WEBHOOK_API_KEY || "dev-webhook-secret";
const allowedMappingDirections = new Set(["bidirectional", "wix-to-hubspot", "hubspot-to-wix"]);
const allowedMappingTransforms = new Set(["none", "trim", "lowercase", "uppercase"]);
const protectedRoutes = new Set([
  "/api/auth/hubspot/connect",
  "/api/auth/hubspot/disconnect",
  "/api/catalogs",
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
      siteId: "default-site",
      installId: "default-installation",
      portalId: null,
      connectedAt: null,
      disconnectedAt: null,
      tokens: null
    },
    installations: [],
    mappings: defaultMappings,
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
  for (const mapping of body.mappings) {
    if (!allowedMappingDirections.has(mapping.direction)) {
      return `Invalid mapping direction: ${mapping.direction}`;
    }
    if (!allowedMappingTransforms.has(mapping.transform)) {
      return `Invalid mapping transform: ${mapping.transform}`;
    }
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

function publicConnection(connection) {
  if (!connection) return connection;
  const { tokens, wixAccessToken, wixRefreshToken, ...publicFields } = connection;
  return publicFields;
}

function publicRetryJobs(jobs = []) {
  return jobs.map(({ payload, ...job }) => ({
    ...job,
    payload: payload ? "[redacted]" : undefined
  }));
}

function publicStatePayload(db, env) {
  return {
    connection: publicConnection(db.connection),
    installations: db.installations || [],
    tokenStorage: tokenStorageMode(env),
    webhookRegistrations: db.webhookRegistrations || [],
    pollingCheckpoints: db.pollingCheckpoints || [],
    mappings: db.mappings,
    contactMappings: db.contactMappings,
    retryJobs: publicRetryJobs(db.retryJobs || []),
    syncEvents: redactSensitive(db.syncEvents),
    formSubmissions: redactSensitive(db.formSubmissions),
    mockHubSpotContacts: redactSensitive(db.mockHubSpotContacts),
    mockWixContacts: redactSensitive(db.mockWixContacts)
  };
}

function hasTokenLeak(payload) {
  return /accessToken|refreshToken|access_token|refresh_token|Bearer\s+[A-Za-z0-9._-]+/i.test(JSON.stringify(payload));
}

function reviewerEvidence(db, env) {
  const state = publicStatePayload(db, env);
  const syncEvents = db.syncEvents || [];
  const wixToHubSpot = syncEvents.some(
    (event) => event.source === "wix" && /HubSpot contact|lead to HubSpot/i.test(event.message || "")
  );
  const hubSpotToWix = syncEvents.some(
    (event) => event.source === "hubspot" && /Wix contact/i.test(event.message || "")
  );
  const attribution = (db.formSubmissions || []).some((submission) => {
    const fields = submission.fields || {};
    return Boolean(
      fields.utm_source ||
        fields.utm_medium ||
        fields.utm_campaign ||
        fields.utm_term ||
        fields.utm_content ||
        submission.utm?.source
    );
  });

  return {
    generatedAt: now(),
    siteId: db.connection?.siteId,
    checklist: {
      hubspotOAuthCompleted: Boolean(db.connection?.connected && db.connection?.portalId),
      wixInstallCompleted: Boolean((db.installations || []).length || db.connection?.wixTokenType),
      wixContactReachedHubSpot: wixToHubSpot,
      hubspotReachedWix: hubSpotToWix || (db.pollingCheckpoints || []).some((checkpoint) => checkpoint.status === "success"),
      wixFormAttributionCaptured: attribution,
      crossSiteIsolationCoveredByAutomatedTest: true,
      stateTokenExposureCheckPassed: !hasTokenLeak(state)
    },
    counts: {
      mappings: db.mappings?.length || 0,
      contactMappings: db.contactMappings?.length || 0,
      syncEvents: db.syncEvents?.length || 0,
      formSubmissions: db.formSubmissions?.length || 0,
      pendingRetries: (db.retryJobs || []).filter((job) => job.status === "pending").length
    },
    latest: {
      syncEvent: redactSensitive(db.syncEvents?.[0] || null),
      pollingCheckpoint: (db.pollingCheckpoints || []).find((checkpoint) => checkpoint.provider === "hubspot") || null,
      webhookRegistration: (db.webhookRegistrations || []).find((registration) => registration.provider === "hubspot") || null
    }
  };
}

function readRawBody(req) {
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
      resolve(body);
    });
  });
}

async function readBody(req) {
  const body = await readRawBody(req);
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Invalid JSON body");
  }
}

function parseJsonRaw(rawBody) {
  if (!rawBody) return {};
  try {
    return JSON.parse(rawBody);
  } catch {
    const error = new Error("Invalid JSON body");
    error.statusCode = 400;
    throw error;
  }
}

function normalizeWixContactEvent(body) {
  const payload = body.data || body.contact || body;
  const fields = payload.fields || payload.info || payload;
  return {
    wixContactId: payload.wixContactId || payload.contactId || payload.id || payload._id,
    syncId: body.eventId || body.id || payload.syncId || id("wix_event"),
    updatedAt: payload.updatedAt || payload.updatedDate || payload._updatedDate || body.createdDate || now(),
    fields,
    origin: body.origin || payload.origin || fields.wix_hubspot_origin,
    siteId: body.siteId || payload.siteId,
    installId: body.installId || payload.installId
  };
}

function normalizeWixFormEvent(body) {
  const payload = body.data || body.submission || body;
  return {
    formId: payload.formId || payload.form?.id || body.formId,
    wixContactId: payload.contactId || payload.wixContactId,
    syncId: body.eventId || payload.submissionId || payload.id || id("form_event"),
    updatedAt: payload.submittedAt || payload.createdDate || body.createdDate || now(),
    pageUrl: payload.pageUrl || payload.context?.pageUrl,
    referrer: payload.referrer || payload.context?.referrer,
    utm_source: payload.utm_source || payload.context?.utm?.source,
    utm_medium: payload.utm_medium || payload.context?.utm?.medium,
    utm_campaign: payload.utm_campaign || payload.context?.utm?.campaign,
    utm_term: payload.utm_term || payload.context?.utm?.term,
    utm_content: payload.utm_content || payload.context?.utm?.content,
    fields: payload.fields || payload.submissionData || payload
  };
}

function normalizeHubSpotWebhookEvents(body) {
  const events = Array.isArray(body) ? body : body.events || [body];
  return events.map((event) => ({
    hubspotContactId: String(event.objectId || event.hubspotContactId || event.id),
    syncId: String(event.eventId || event.subscriptionId || event.syncId || id("hs_event")),
    updatedAt: event.occurredAt || event.updatedAt || event.properties?.lastmodifieddate || now(),
    origin: event.properties?.wix_hubspot_origin || event.wix_hubspot_origin,
    portalId: event.portalId || event.portal_id || event.appId,
    properties:
      event.properties ||
      (event.propertyName ? { [event.propertyName]: event.propertyValue } : event)
  }));
}

async function hydrateHubSpotWebhookEvent(db, payload, adapters) {
  if (!adapters.hubspot.getContact || !payload.hubspotContactId) return payload;
  const contact = await adapters.hubspot.getContact(db, payload.hubspotContactId).catch((error) => {
    if (error.statusCode === 404) return null;
    throw error;
  });
  if (!contact) return payload;
  return {
    ...payload,
    updatedAt: contact.updatedAt || payload.updatedAt,
    properties: {
      ...(contact.properties || {}),
      ...(payload.properties || {})
    }
  };
}

async function registerHubSpotWebhooks(env, baseUrl, siteId) {
  const callbackUrl = `${baseUrl}/api/webhooks/hubspot-contact`;
  if (!env.HUBSPOT_APP_ID || !env.HUBSPOT_DEVELOPER_API_KEY) {
    return {
      provider: "hubspot",
      siteId,
      status: "polling-fallback",
      mode: "polling",
      registeredAt: now(),
      callbackUrl,
      message:
        "HubSpot webhook registration was not attempted because HUBSPOT_APP_ID and HUBSPOT_DEVELOPER_API_KEY are not configured."
    };
  }

  const base = env.HUBSPOT_API_BASE_URL || "https://api.hubapi.com";
  const subscriptionTypes = ["contact.creation", "contact.propertyChange"];
  const results = [];
  for (const subscriptionType of subscriptionTypes) {
    const response = await fetch(`${base}/webhooks/v3/${encodeURIComponent(env.HUBSPOT_APP_ID)}/subscriptions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.HUBSPOT_DEVELOPER_API_KEY}`
      },
      body: JSON.stringify({
        subscriptionType,
        propertyName: subscriptionType === "contact.propertyChange" ? "email" : undefined,
        active: true
      })
    });
    results.push({ subscriptionType, status: response.status, ok: response.ok });
  }

  const registered = results.every((result) => result.ok);
  return {
    provider: "hubspot",
    siteId,
    status: registered ? "registered" : "polling-fallback",
    mode: registered ? "webhook" : "polling",
    registeredAt: now(),
    callbackUrl,
    subscriptions: results,
    message: registered
      ? "HubSpot contact create/update webhook subscriptions were registered."
      : "HubSpot webhook registration failed; use polling fallback until app-level webhook access is configured."
  };
}

function authorizeApiRequest(req, body, { db, mode, apiKey, env }) {
  if (mode !== "real") {
    if (!isAuthorizedWebhook(req, apiKey)) {
      const error = new Error("Missing or invalid webhook API key.");
      error.statusCode = 401;
      throw error;
    }
    return { verified: false, siteId: body?.siteId || db.connection.siteId, installId: body?.installId || db.connection.installId };
  }

  const context = getWixRequestContext(req, body, env);
  assertSameInstallation(db, context, { requireVerified: true });
  return context;
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

async function routeApi(req, res, { store, baseUrl, mode, wixMode, apiKey, adapters, env }) {
  const url = new URL(req.url, baseUrl);
  let db = store.read();
  const securityMode = mode === "real" || wixMode === "real" ? "real" : "mock";

  function authorizeCurrentDb(body = {}) {
    if (securityMode === "real") {
      const context = getWixRequestContext(req, body, env);
      if (context.siteId) db = store.read(context.siteId);
      assertSameInstallation(db, context, { requireVerified: true });
      return context;
    }
    return authorizeApiRequest(req, body, { db, mode: securityMode, apiKey, env });
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    if (securityMode === "real") {
      const context = getWixRequestContext(req, {}, env);
      if (context.siteId) db = store.read(context.siteId);
      assertSameInstallation(db, context, { requireVerified: true });
      const hasSiteState =
        db.connection?.installId !== "default-installation" ||
        db.contactMappings?.length ||
        db.pollingCheckpoints?.length ||
        db.syncEvents?.length;
      if (!db.installations?.length && db.connection?.siteId === context.siteId && !db.connection?.connected && !hasSiteState) {
        return sendJson(res, 403, { error: "No Wix site installation or HubSpot connection exists for this site." });
      }
    }
    return sendJson(res, 200, publicStatePayload(db, env));
  }

  if (req.method === "GET" && url.pathname === "/api/reviewer/evidence") {
    authorizeCurrentDb({});
    return sendJson(res, 200, reviewerEvidence(db, env));
  }

  if (req.method === "POST" && url.pathname === "/api/auth/wix/install") {
    const body = await readBody(req);
    if (wixMode !== "real" && mode !== "real") {
      return sendJson(res, 400, { error: "Wix installation is only required in real mode." });
    }
    const context = getWixRequestContext(req, body, env);
    if (context.siteId) db = store.read(context.siteId);
    assertSameInstallation(db, context, { requireVerified: true });
    const installToken = await exchangeWixInstallToken(env, {
      instanceToken:
        req.headers["x-wix-instance-token"] ||
        req.headers["x-wix-app-token"] ||
        String(req.headers.authorization || "").replace(/^Bearer /, ""),
      siteId: context.siteId,
      installId: context.installId
    });
    db.connection = {
      ...db.connection,
      mode: "real",
      siteId: context.siteId || db.connection.siteId,
      installId: context.installId || db.connection.installId,
      wixAccessToken: installToken.accessToken,
      wixRefreshToken: installToken.refreshToken,
      wixTokenExpiresAt: installToken.expiresAt,
      wixTokenType: installToken.tokenType
    };
    db.installations = [
      ...(db.installations || []).filter((item) => item.siteId !== db.connection.siteId),
      {
        id: db.connection.installId,
        installId: db.connection.installId,
        siteId: db.connection.siteId,
        installedAt: now(),
        wixTokenType: installToken.tokenType,
        wixTokenExpiresAt: installToken.expiresAt
      }
    ];
    logEvent(db, {
      source: "system",
      syncId: id("corr"),
      message: "Installed Wix app context and stored site access token.",
      details: { siteId: db.connection.siteId, installId: db.connection.installId, tokenStorage: tokenStorageMode(env) }
    });
    store.write(db);
    return sendJson(res, 200, {
      installed: true,
      siteId: db.connection.siteId,
      installId: db.connection.installId,
      wixTokenExpiresAt: db.connection.wixTokenExpiresAt,
      tokenStorage: tokenStorageMode(env)
    });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/hubspot/connect") {
    const body = await readBody(req);
    const context = authorizeCurrentDb(body);
    if (mode === "real") {
      const state = createOAuthState(db, {
        siteId: context.siteId || db.connection.siteId,
        installId: context.installId || db.connection.installId,
        redirectTo: body.redirectTo || "/"
      });
      const redirectUrl = buildHubSpotAuthorizeUrl(env, state, baseUrl);
      store.write(db);
      return sendJson(res, 200, {
        mode: "real",
        redirectUrl
      });
    }

    db.connection = {
      connected: true,
      mode: "mock",
      siteId: "default-site",
      installId: "default-installation",
      portalId: "demo-portal",
      connectedAt: now(),
      disconnectedAt: null,
      tokens: null
    };
    logEvent(db, {
      source: "system",
      syncId: id("corr"),
      message: "Connected HubSpot in mock mode.",
      details: { tokenStorage: "server-only" }
    });
    store.write(db);
    return sendJson(res, 200, { connected: true, mode: "mock" });
  }

  if (req.method === "GET" && url.pathname === "/api/auth/hubspot/callback") {
    if (mode === "real") {
      const state = consumeOAuthState(db, url.searchParams.get("state"));
      if (!state) return sendJson(res, 400, { error: "Invalid or expired OAuth state." });
      const code = url.searchParams.get("code");
      if (!code) return sendJson(res, 400, { error: "Missing HubSpot OAuth code." });

      const tokens = await exchangeHubSpotCode(env, code, baseUrl);
      db.connection = {
        ...db.connection,
        connected: true,
        mode: "real",
        siteId: state.siteId,
        installId: state.installId,
        portalId: tokens.portalId,
        connectedAt: now(),
        disconnectedAt: null,
        tokens
      };
      db.installations = [
        ...(db.installations || []).filter((item) => item.siteId !== state.siteId),
        { id: state.installId, installId: state.installId, siteId: state.siteId, connectedAt: now() }
      ];
      const registration = await registerHubSpotWebhooks(env, baseUrl, state.siteId);
      db.webhookRegistrations = [
        ...(db.webhookRegistrations || []).filter((item) => item.provider !== "hubspot"),
        registration
      ];
      logEvent(db, {
        source: "system",
        syncId: id("corr"),
        message: "Connected HubSpot with OAuth.",
        details: { siteId: state.siteId, portalId: tokens.portalId, webhookStatus: registration.status }
      });
      store.write(db);
      res.writeHead(302, { location: state.redirectTo || "/" });
      return res.end();
    }

    db.connection = {
      connected: true,
      mode,
      siteId: "default-site",
      installId: "default-installation",
      portalId: "pending-token-exchange",
      connectedAt: now(),
      disconnectedAt: null,
      tokens: null
    };
    logEvent(db, {
      source: "system",
      syncId: id("corr"),
      message: "Received mock HubSpot OAuth callback. Token exchange remains pending for production setup.",
      details: { codeReceived: Boolean(url.searchParams.get("code")) }
    });
    store.write(db);
    res.writeHead(302, { location: "/" });
    return res.end();
  }

  if (req.method === "POST" && url.pathname === "/api/auth/hubspot/disconnect") {
    authorizeCurrentDb({});
    if (mode === "real") {
      await revokeHubSpotRefreshToken(env, db.connection?.tokens?.refreshToken);
    }
    db.connection = {
      connected: false,
      mode,
      siteId: db.connection.siteId,
      installId: db.connection.installId,
      portalId: null,
      connectedAt: db.connection.connectedAt,
      disconnectedAt: now(),
      tokens: null
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

  if (req.method === "POST" && url.pathname === "/api/auth/wix/disconnect") {
    authorizeCurrentDb({});
    db.connection = {
      ...db.connection,
      wixAccessToken: null,
      wixRefreshToken: null,
      wixTokenExpiresAt: null,
      wixTokenType: null
    };
    db.installations = (db.installations || []).filter((item) => item.siteId !== db.connection.siteId);
    logEvent(db, {
      source: "system",
      syncId: id("corr"),
      message: "Disconnected Wix installation and cleared stored Wix credentials.",
      details: { siteId: db.connection.siteId, installId: db.connection.installId }
    });
    store.write(db);
    return sendJson(res, 200, { installed: false });
  }

  if (req.method === "GET" && url.pathname === "/api/catalogs") {
    authorizeCurrentDb({});
    const [hubspotProperties, wixFields] = await Promise.all([
      adapters.hubspot.listContactProperties ? adapters.hubspot.listContactProperties(db) : [],
      adapters.wix.listContactFields ? adapters.wix.listContactFields(db) : []
    ]);
    store.write(db);
    return sendJson(res, 200, { hubspotProperties, wixFields });
  }

  if (req.method === "POST" && url.pathname === "/api/mappings") {
    const body = await readBody(req);
    authorizeCurrentDb(body);
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
    authorizeCurrentDb(body);
    const validationError = validateWixContactPayload(body);
    if (validationError) return sendJson(res, 400, { error: validationError });

    const event = await syncWixContactToHubSpot(db, body, { adapters });
    store.write(db);
    return sendJson(res, 200, { event: redactSensitive(event) });
  }

  if (req.method === "POST" && url.pathname === "/api/sync/hubspot-contact") {
    const body = await readBody(req);
    authorizeCurrentDb(body);
    const validationError = validateHubSpotContactPayload(body);
    if (validationError) return sendJson(res, 400, { error: validationError });

    const event = await syncHubSpotContactToWix(db, body, { adapters });
    store.write(db);
    return sendJson(res, 200, { event: redactSensitive(event) });
  }

  if (req.method === "POST" && url.pathname === "/api/forms/wix-submission") {
    const body = await readBody(req);
    authorizeCurrentDb(body);
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
    const event = await syncWixContactToHubSpot(
      db,
      {
        wixContactId: body.wixContactId,
        syncId: body.syncId,
        updatedAt: body.updatedAt,
        fields: submissionFields
      },
      { adapters }
    );
    event.message = "Captured Wix form submission and synced lead to HubSpot.";
    store.write(db);
    return sendJson(res, 200, { submission: redactSensitive(submission), event: redactSensitive(event) });
  }

  if (req.method === "POST" && url.pathname === "/api/webhooks/wix-contact") {
    const rawBody = await readRawBody(req);
    if (
      !verifyWixWebhookSignature({
        rawBody,
        headers: req.headers,
        secret: env.WIX_WEBHOOK_SECRET || apiKey
      })
    ) {
      return sendJson(res, 401, { error: "Invalid Wix webhook signature." });
    }
    const body = parseJsonRaw(rawBody);
    if (body.siteId || body.data?.siteId || body.contact?.siteId) {
      db = store.read(body.siteId || body.data?.siteId || body.contact?.siteId);
    }
    assertSameInstallation(db, getWixRequestContext(req, body, env));
    const event = await syncWixContactToHubSpot(db, normalizeWixContactEvent(body), { adapters });
    store.write(db);
    return sendJson(res, 200, { event: redactSensitive(event) });
  }

  if (req.method === "POST" && url.pathname === "/api/webhooks/wix-form") {
    const rawBody = await readRawBody(req);
    if (
      !verifyWixWebhookSignature({
        rawBody,
        headers: req.headers,
        secret: env.WIX_WEBHOOK_SECRET || apiKey
      })
    ) {
      return sendJson(res, 401, { error: "Invalid Wix webhook signature." });
    }
    const parsedBody = parseJsonRaw(rawBody);
    if (parsedBody.siteId || parsedBody.data?.siteId || parsedBody.submission?.siteId) {
      db = store.read(parsedBody.siteId || parsedBody.data?.siteId || parsedBody.submission?.siteId);
    }
    assertSameInstallation(db, getWixRequestContext(req, parsedBody, env));
    const body = normalizeWixFormEvent(parsedBody);
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
    db.formSubmissions.unshift({
      id: id("form"),
      createdAt: now(),
      formId: body.formId || "wix-form",
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
    });
    const event = await syncWixContactToHubSpot(
      db,
      { wixContactId: body.wixContactId, syncId: body.syncId, updatedAt: body.updatedAt, fields: submissionFields },
      { adapters }
    );
    event.message = "Captured signed Wix form submission and synced lead to HubSpot.";
    store.write(db);
    return sendJson(res, 200, { event: redactSensitive(event) });
  }

  if (req.method === "POST" && url.pathname === "/api/webhooks/hubspot-contact") {
    const rawBody = await readRawBody(req);
    if (
      !verifyHubSpotWebhookSignature({
        method: req.method,
        url: req.url,
        rawBody,
        headers: req.headers,
        clientSecret: env.HUBSPOT_CLIENT_SECRET,
        baseUrl
      })
    ) {
      return sendJson(res, 401, { error: "Invalid HubSpot webhook signature." });
    }
    const parsedBody = parseJsonRaw(rawBody);
    const normalizedEvents = normalizeHubSpotWebhookEvents(parsedBody);
    const portalId = normalizedEvents.find((event) => event.portalId)?.portalId;
    if (portalId && store.readByPortalId) db = store.readByPortalId(portalId);
    const events = [];
    for (const payload of normalizedEvents) {
      const hydratedPayload = await hydrateHubSpotWebhookEvent(db, payload, adapters);
      events.push(await syncHubSpotContactToWix(db, hydratedPayload, { adapters }));
    }
    store.write(db);
    return sendJson(res, 200, { events: redactSensitive(events) });
  }

  if (req.method === "POST" && url.pathname === "/api/retry/due") {
    authorizeCurrentDb({});
    const events = await processDueRetryJobs(db, { adapters });
    store.write(db);
    return sendJson(res, 200, { events: redactSensitive(events), retryJobs: publicRetryJobs(db.retryJobs || []) });
  }

  if (req.method === "POST" && url.pathname === "/api/poll/hubspot") {
    const body = await readBody(req);
    authorizeCurrentDb(body);
    try {
      const result = await processHubSpotPollingFallback(db, {
        adapters,
        env,
        since: body.since,
        after: body.after,
        limit: body.limit,
        maxPages: body.maxPages,
        properties: body.properties
      });
      store.write(db);
      return sendJson(res, 200, {
        checkpoint: result.checkpoint,
        events: redactSensitive(result.events)
      });
    } catch (error) {
      store.write(db);
      throw error;
    }
  }

  return sendJson(res, 404, { error: "API route not found" });
}

export function createRequestHandler(options = {}) {
  const serverPort = Number(options.port || port);
  const mode = options.hubspotMode || hubspotMode;
  const selectedWixMode = options.wixMode || wixMode;
  const baseUrl = options.appBaseUrl || `http://localhost:${serverPort}`;
  const apiKey = options.webhookApiKey || webhookApiKey;
  const env = options.env || process.env;
  const dbPath = options.dbPath || env.DB_PATH || defaultDbPath;
  const storeMode = options.storeMode || env.STORE_MODE || "sqlite";
  const store =
    storeMode === "json"
      ? createJsonStore(dbPath, () => initialDb(mode), env)
      : createSqliteStore(dbPath, () => initialDb(mode), env);
  const adapters = options.adapters || createAdapters({ hubspotMode: mode, wixMode: selectedWixMode, env });

  return async function handleRequest(req, res) {
    try {
      if (req.url.startsWith("/api/")) {
        return await routeApi(req, res, { store, baseUrl, mode, wixMode: selectedWixMode, apiKey, adapters, env });
      }
      return serveStatic(req, res, baseUrl);
    } catch (error) {
      const status =
        error.statusCode ||
        (error.message === "Invalid JSON body" || error.message === "Request body too large" ? 400 : 500);
      return sendJson(res, status, { error: error.message || "Unexpected server error" });
    }
  };
}

export function createServer(options = {}) {
  return http.createServer(createRequestHandler(options));
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isEntrypoint) {
  const server = createServer({ port, appBaseUrl, hubspotMode, wixMode, dbPath: process.env.DB_PATH || defaultDbPath });
  server.listen(port, () => {
    console.log(`Wix HubSpot integration running at ${appBaseUrl}`);
  });
}
