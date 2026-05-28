import { upsertMockHubSpotContact } from "../adapters/mockHubSpotAdapter.js";
import { upsertMockWixContact } from "../adapters/mockWixAdapter.js";
import { id, now } from "../lib/time.js";
import { mapHubSpotPropertiesToWix, mapWixFieldsToHubSpot } from "./fieldMapper.js";

const APP_ORIGIN = "wix-hubspot-integration";

export function logEvent(db, event) {
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

function getOrigin(payload) {
  return (
    payload.origin ||
    payload.source ||
    payload.fields?.origin ||
    payload.fields?.source ||
    payload.properties?.origin ||
    payload.properties?.source ||
    payload.properties?.wix_hubspot_origin
  );
}

function isSelfProducedEvent(payload) {
  return getOrigin(payload) === APP_ORIGIN;
}

function findContactMapping(db, { wixContactId, hubspotContactId }) {
  return db.contactMappings.find((mapping) => {
    return (
      (wixContactId && mapping.wixContactId === wixContactId) ||
      (hubspotContactId && mapping.hubspotContactId === hubspotContactId)
    );
  });
}

function normalizeTimestamp(value) {
  if (!value) return now();
  if (typeof value === "number" || /^\d+$/.test(String(value))) {
    const numericValue = Number(value);
    return new Date(numericValue > 10_000_000_000 ? numericValue : numericValue * 1000).toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? now() : parsed.toISOString();
}

function getSourceUpdatedAt(payload, source) {
  const fields = payload.fields || {};
  const properties = payload.properties || {};
  return normalizeTimestamp(
    payload.updatedAt ||
      fields.updatedAt ||
      fields.lastUpdated ||
      properties.updatedAt ||
      properties.lastmodifieddate ||
      properties.hs_lastmodifieddate ||
      (source === "wix" ? fields._updatedDate : undefined)
  );
}

function isAfter(left, right) {
  return new Date(left).getTime() > new Date(right).getTime();
}

function isStaleComparedToOppositeSource(mapping, source, sourceUpdatedAt) {
  if (!mapping) return false;
  if (source === "wix" && mapping.lastHubSpotUpdatedAt) {
    return !isAfter(sourceUpdatedAt, mapping.lastHubSpotUpdatedAt);
  }
  if (source === "hubspot" && mapping.lastWixUpdatedAt) {
    return !isAfter(sourceUpdatedAt, mapping.lastWixUpdatedAt);
  }
  return false;
}

function saveContactMapping(db, { wixContactId, hubspotContactId, syncId, source, sourceUpdatedAt }) {
  const existing = findContactMapping(db, { wixContactId, hubspotContactId });
  if (existing) {
    existing.wixContactId = wixContactId || existing.wixContactId;
    existing.hubspotContactId = hubspotContactId || existing.hubspotContactId;
    existing.lastSyncId = syncId;
    if (source === "wix") existing.lastWixUpdatedAt = sourceUpdatedAt;
    if (source === "hubspot") existing.lastHubSpotUpdatedAt = sourceUpdatedAt;
    existing.updatedAt = now();
    return existing;
  }

  const mapping = {
    id: id("contact_map"),
    wixContactId,
    hubspotContactId,
    lastSyncId: syncId,
    lastWixUpdatedAt: source === "wix" ? sourceUpdatedAt : null,
    lastHubSpotUpdatedAt: source === "hubspot" ? sourceUpdatedAt : null,
    createdAt: now(),
    updatedAt: now()
  };
  db.contactMappings.push(mapping);
  return mapping;
}

export function syncWixContactToHubSpot(db, payload) {
  const syncId = payload.syncId || id("corr");
  const wixContactId = payload.wixContactId || id("wix");
  const sourceUpdatedAt = getSourceUpdatedAt(payload, "wix");
  const mapping = findContactMapping(db, { wixContactId });

  if (isSelfProducedEvent(payload)) {
    return logEvent(db, {
      source: "wix",
      syncId,
      status: "skipped",
      message: "Ignored Wix event produced by this integration.",
      details: { wixContactId, origin: APP_ORIGIN }
    });
  }

  if (mapping?.lastSyncId === syncId) {
    return logEvent(db, {
      source: "wix",
      syncId,
      message: "Ignored duplicate Wix event with same syncId.",
      details: { wixContactId, hubspotContactId: mapping.hubspotContactId }
    });
  }

  if (isStaleComparedToOppositeSource(mapping, "wix", sourceUpdatedAt)) {
    return logEvent(db, {
      source: "wix",
      syncId,
      status: "skipped",
      message: "Skipped stale Wix update because HubSpot has the latest timestamp.",
      details: {
        wixContactId,
        hubspotContactId: mapping.hubspotContactId,
        wixUpdatedAt: sourceUpdatedAt,
        hubSpotUpdatedAt: mapping.lastHubSpotUpdatedAt
      }
    });
  }

  const properties = mapWixFieldsToHubSpot(payload.fields || payload, db.mappings);
  const { contact, action } = upsertMockHubSpotContact(db, properties, mapping?.hubspotContactId, sourceUpdatedAt);
  saveContactMapping(db, { wixContactId, hubspotContactId: contact.id, syncId, source: "wix", sourceUpdatedAt });

  return logEvent(db, {
    source: "wix",
    syncId,
    message: `Wix contact ${action} HubSpot contact.`,
    details: { wixContactId, hubspotContactId: contact.id, sourceUpdatedAt, properties }
  });
}

export function syncHubSpotContactToWix(db, payload) {
  const syncId = payload.syncId || id("corr");
  const hubspotContactId = payload.hubspotContactId || id("hs");
  const sourceUpdatedAt = getSourceUpdatedAt(payload, "hubspot");
  const mapping = findContactMapping(db, { hubspotContactId });

  if (isSelfProducedEvent(payload)) {
    return logEvent(db, {
      source: "hubspot",
      syncId,
      status: "skipped",
      message: "Ignored HubSpot event produced by this integration.",
      details: { hubspotContactId, origin: APP_ORIGIN }
    });
  }

  if (mapping?.lastSyncId === syncId) {
    return logEvent(db, {
      source: "hubspot",
      syncId,
      message: "Ignored duplicate HubSpot event with same syncId.",
      details: { wixContactId: mapping.wixContactId, hubspotContactId }
    });
  }

  if (isStaleComparedToOppositeSource(mapping, "hubspot", sourceUpdatedAt)) {
    return logEvent(db, {
      source: "hubspot",
      syncId,
      status: "skipped",
      message: "Skipped stale HubSpot update because Wix has the latest timestamp.",
      details: {
        wixContactId: mapping.wixContactId,
        hubspotContactId,
        wixUpdatedAt: mapping.lastWixUpdatedAt,
        hubSpotUpdatedAt: sourceUpdatedAt
      }
    });
  }

  const fields = mapHubSpotPropertiesToWix(payload.properties || payload, db.mappings);
  const { contact, action } = upsertMockWixContact(db, fields, mapping?.wixContactId, sourceUpdatedAt);
  saveContactMapping(db, { wixContactId: contact.id, hubspotContactId, syncId, source: "hubspot", sourceUpdatedAt });

  return logEvent(db, {
    source: "hubspot",
    syncId,
    message: `HubSpot contact ${action} Wix contact.`,
    details: { wixContactId: contact.id, hubspotContactId, sourceUpdatedAt, fields }
  });
}
