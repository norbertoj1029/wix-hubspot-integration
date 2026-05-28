import { upsertMockHubSpotContact } from "../adapters/mockHubSpotAdapter.js";
import { upsertMockWixContact } from "../adapters/mockWixAdapter.js";
import { id, now } from "../lib/time.js";
import { mapHubSpotPropertiesToWix, mapWixFieldsToHubSpot } from "./fieldMapper.js";

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

export function syncWixContactToHubSpot(db, payload) {
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

  const properties = mapWixFieldsToHubSpot(payload.fields || payload, db.mappings);
  const { contact, action } = upsertMockHubSpotContact(db, properties, mapping?.hubspotContactId);
  saveContactMapping(db, { wixContactId, hubspotContactId: contact.id, syncId });

  return logEvent(db, {
    source: "wix",
    syncId,
    message: `Wix contact ${action} HubSpot contact.`,
    details: { wixContactId, hubspotContactId: contact.id, properties }
  });
}

export function syncHubSpotContactToWix(db, payload) {
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

  const fields = mapHubSpotPropertiesToWix(payload.properties || payload, db.mappings);
  const { contact, action } = upsertMockWixContact(db, fields, mapping?.wixContactId);
  saveContactMapping(db, { wixContactId: contact.id, hubspotContactId, syncId });

  return logEvent(db, {
    source: "hubspot",
    syncId,
    message: `HubSpot contact ${action} Wix contact.`,
    details: { wixContactId: contact.id, hubspotContactId, fields }
  });
}
