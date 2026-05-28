import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const publicDir = join(rootDir, "public");
const dataDir = join(rootDir, "data");
const dbPath = join(dataDir, "app-db.json");

const port = Number(process.env.PORT || 3000);
const appBaseUrl = process.env.APP_BASE_URL || `http://localhost:${port}`;
const hubspotMode = process.env.HUBSPOT_MODE || "mock";

const defaultMappings = [
  {
    id: "map_email",
    wixField: "email",
    hubspotProperty: "email",
    direction: "bidirectional",
    transform: "lowercase"
  },
  {
    id: "map_first_name",
    wixField: "firstName",
    hubspotProperty: "firstname",
    direction: "bidirectional",
    transform: "trim"
  },
  {
    id: "map_last_name",
    wixField: "lastName",
    hubspotProperty: "lastname",
    direction: "bidirectional",
    transform: "trim"
  },
  {
    id: "map_phone",
    wixField: "phone",
    hubspotProperty: "phone",
    direction: "wix-to-hubspot",
    transform: "trim"
  },
  {
    id: "map_utm_source",
    wixField: "utm_source",
    hubspotProperty: "wix_utm_source",
    direction: "wix-to-hubspot",
    transform: "trim"
  },
  {
    id: "map_utm_campaign",
    wixField: "utm_campaign",
    hubspotProperty: "wix_utm_campaign",
    direction: "wix-to-hubspot",
    transform: "trim"
  },
  {
    id: "map_page_url",
    wixField: "pageUrl",
    hubspotProperty: "wix_page_url",
    direction: "wix-to-hubspot",
    transform: "trim"
  },
  {
    id: "map_referrer",
    wixField: "referrer",
    hubspotProperty: "wix_referrer",
    direction: "wix-to-hubspot",
    transform: "trim"
  }
];

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

function ensureDb() {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  if (!existsSync(dbPath)) writeFileSync(dbPath, JSON.stringify(initialDb(), null, 2));
}

function readDb() {
  ensureDb();
  return JSON.parse(readFileSync(dbPath, "utf8"));
}

function writeDb(db) {
  writeFileSync(dbPath, JSON.stringify(db, null, 2));
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store"
  });
  res.end(body);
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

function id(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function now() {
  return new Date().toISOString();
}

function applyTransform(value, transform) {
  if (value === undefined || value === null) return value;
  const stringValue = String(value);
  if (transform === "lowercase") return stringValue.trim().toLowerCase();
  if (transform === "uppercase") return stringValue.trim().toUpperCase();
  if (transform === "trim") return stringValue.trim();
  return value;
}

function allowedByDirection(mapping, direction) {
  return mapping.direction === "bidirectional" || mapping.direction === direction;
}

function mapFields(input, mappings, direction) {
  return mappings
    .filter((mapping) => allowedByDirection(mapping, direction))
    .reduce((output, mapping) => {
      if (Object.prototype.hasOwnProperty.call(input, mapping.wixField)) {
        output[mapping.hubspotProperty] = applyTransform(input[mapping.wixField], mapping.transform);
      }
      return output;
    }, {});
}

function reverseMapFields(input, mappings) {
  return mappings
    .filter((mapping) => allowedByDirection(mapping, "hubspot-to-wix"))
    .reduce((output, mapping) => {
      if (Object.prototype.hasOwnProperty.call(input, mapping.hubspotProperty)) {
        output[mapping.wixField] = applyTransform(input[mapping.hubspotProperty], mapping.transform);
      }
      return output;
    }, {});
}

function logEvent(db, event) {
  const entry = {
    id: id("sync"),
    createdAt: now(),
    status: "success",
    ...event
  };
  db.syncEvents.unshift(entry);
  db.syncEvents = db.syncEvents.slice(0, 100);
  return entry;
}

function samePayload(left, right) {
  return JSON.stringify(left || {}) === JSON.stringify(right || {});
}

function upsertMockHubSpotContact(db, properties, existingHubSpotId) {
  const byId = existingHubSpotId
    ? db.mockHubSpotContacts.find((contact) => contact.id === existingHubSpotId)
    : null;
  const byEmail = properties.email
    ? db.mockHubSpotContacts.find((contact) => contact.properties.email === properties.email)
    : null;
  const contact = byId || byEmail;

  if (contact) {
    if (!samePayload(contact.properties, { ...contact.properties, ...properties })) {
      contact.properties = { ...contact.properties, ...properties };
      contact.updatedAt = now();
    }
    return { contact, action: "updated" };
  }

  const created = {
    id: id("hs"),
    properties,
    createdAt: now(),
    updatedAt: now()
  };
  db.mockHubSpotContacts.push(created);
  return { contact: created, action: "created" };
}

function upsertMockWixContact(db, fields, existingWixId) {
  const byId = existingWixId ? db.mockWixContacts.find((contact) => contact.id === existingWixId) : null;
  const byEmail = fields.email ? db.mockWixContacts.find((contact) => contact.fields.email === fields.email) : null;
  const contact = byId || byEmail;

  if (contact) {
    contact.fields = { ...contact.fields, ...fields };
    contact.updatedAt = now();
    return { contact, action: "updated" };
  }

  const created = {
    id: id("wix"),
    fields,
    createdAt: now(),
    updatedAt: now()
  };
  db.mockWixContacts.push(created);
  return { contact: created, action: "created" };
}

function findContactMapping(db, { wixContactId, hubspotContactId }) {
  return db.contactMappings.find((mapping) => {
    return (
      (wixContactId && mapping.wixContactId === wixContactId) ||
      (hubspotContactId && mapping.hubspotContactId === hubspotContactId)
    );
  });
}

function saveContactMapping(db, { wixContactId, hubspotContactId, syncId }) {
  const existing = findContactMapping(db, { wixContactId, hubspotContactId });
  if (existing) {
    existing.wixContactId = wixContactId || existing.wixContactId;
    existing.hubspotContactId = hubspotContactId || existing.hubspotContactId;
    existing.lastSyncId = syncId;
    existing.updatedAt = now();
    return existing;
  }

  const mapping = {
    id: id("contact_map"),
    wixContactId,
    hubspotContactId,
    lastSyncId: syncId,
    createdAt: now(),
    updatedAt: now()
  };
  db.contactMappings.push(mapping);
  return mapping;
}

function syncWixContactToHubSpot(db, payload) {
  const syncId = payload.syncId || id("corr");
  const wixContactId = payload.wixContactId || id("wix");
  const mapping = findContactMapping(db, { wixContactId });

  if (mapping?.lastSyncId === syncId) {
    return logEvent(db, {
      source: "wix",
      syncId,
      message: "Ignored duplicate Wix event with same syncId.",
      details: { wixContactId, hubspotContactId: mapping.hubspotContactId }
    });
  }

  const properties = mapFields(payload.fields || payload, db.mappings, "wix-to-hubspot");
  const { contact, action } = upsertMockHubSpotContact(db, properties, mapping?.hubspotContactId);
  saveContactMapping(db, { wixContactId, hubspotContactId: contact.id, syncId });

  return logEvent(db, {
    source: "wix",
    syncId,
    message: `Wix contact ${action} HubSpot contact.`,
    details: { wixContactId, hubspotContactId: contact.id, properties }
  });
}

function syncHubSpotContactToWix(db, payload) {
  const syncId = payload.syncId || id("corr");
  const hubspotContactId = payload.hubspotContactId || id("hs");
  const mapping = findContactMapping(db, { hubspotContactId });

  if (mapping?.lastSyncId === syncId) {
    return logEvent(db, {
      source: "hubspot",
      syncId,
      message: "Ignored duplicate HubSpot event with same syncId.",
      details: { wixContactId: mapping.wixContactId, hubspotContactId }
    });
  }

  const fields = reverseMapFields(payload.properties || payload, db.mappings);
  const { contact, action } = upsertMockWixContact(db, fields, mapping?.wixContactId);
  saveContactMapping(db, { wixContactId: contact.id, hubspotContactId, syncId });

  return logEvent(db, {
    source: "hubspot",
    syncId,
    message: `HubSpot contact ${action} Wix contact.`,
    details: { wixContactId: contact.id, hubspotContactId, fields }
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
  const db = readDb();

  if (req.method === "GET" && url.pathname === "/api/state") {
    return sendJson(res, 200, {
      connection: db.connection,
      mappings: db.mappings,
      contactMappings: db.contactMappings,
      syncEvents: db.syncEvents,
      formSubmissions: db.formSubmissions,
      mockHubSpotContacts: db.mockHubSpotContacts,
      mockWixContacts: db.mockWixContacts
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
    writeDb(db);
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
    writeDb(db);
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
    writeDb(db);
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
    writeDb(db);
    return sendJson(res, 200, { mappings: db.mappings });
  }

  if (req.method === "POST" && url.pathname === "/api/sync/wix-contact") {
    const body = await readBody(req);
    const event = syncWixContactToHubSpot(db, body);
    writeDb(db);
    return sendJson(res, 200, { event });
  }

  if (req.method === "POST" && url.pathname === "/api/sync/hubspot-contact") {
    const body = await readBody(req);
    const event = syncHubSpotContactToWix(db, body);
    writeDb(db);
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
    writeDb(db);
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
