import { createAdapters } from "../adapters/index.js";
import { id, now } from "../lib/time.js";
import { mapHubSpotPropertiesToWix, mapWixFieldsToHubSpot } from "./fieldMapper.js";

export const APP_ORIGIN = "wix-hubspot-integration";
const PROCESSED_SYNC_ID_LIMIT = 10;
const MAX_RETRY_ATTEMPTS = 5;
const DEFAULT_HUBSPOT_POLL_LOOKBACK_MINUTES = 24 * 60;
const DEFAULT_HUBSPOT_POLL_MAX_PAGES = 10;

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
    payload.fields?.wix_hubspot_origin ||
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

function hasProcessedEvent(db, syncId) {
  return (db.processedEvents || []).some((event) => event.id === syncId);
}

function syncIdFromPayload(payload, fallbackPrefix) {
  return (
    payload.syncId ||
    payload.fields?.wix_hubspot_sync_id ||
    payload.properties?.wix_hubspot_sync_id ||
    id(fallbackPrefix)
  );
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

function isStaleComparedToSameSource(mapping, source, sourceUpdatedAt) {
  if (!mapping) return false;
  if (source === "wix" && mapping.lastWixUpdatedAt) {
    return !isAfter(sourceUpdatedAt, mapping.lastWixUpdatedAt);
  }
  if (source === "hubspot" && mapping.lastHubSpotUpdatedAt) {
    return !isAfter(sourceUpdatedAt, mapping.lastHubSpotUpdatedAt);
  }
  return false;
}

function saveContactMapping(db, { wixContactId, hubspotContactId, syncId, source, sourceUpdatedAt }) {
  db.processedEvents = db.processedEvents || [];
  if (syncId && !hasProcessedEvent(db, syncId)) {
    db.processedEvents.unshift({ id: syncId, source, processedAt: now() });
    db.processedEvents = db.processedEvents.slice(0, 1000);
  }

  const existing = findContactMapping(db, { wixContactId, hubspotContactId });
  if (existing) {
    existing.wixContactId = wixContactId || existing.wixContactId;
    existing.hubspotContactId = hubspotContactId || existing.hubspotContactId;
    existing.lastSyncId = syncId;
    existing.processedSyncIds = [...new Set([...(existing.processedSyncIds || []), syncId])].slice(
      -PROCESSED_SYNC_ID_LIMIT
    );
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
    processedSyncIds: [syncId],
    lastWixUpdatedAt: source === "wix" ? sourceUpdatedAt : null,
    lastHubSpotUpdatedAt: source === "hubspot" ? sourceUpdatedAt : null,
    createdAt: now(),
    updatedAt: now()
  };
  db.contactMappings.push(mapping);
  return mapping;
}

function finishWixToHubSpot(db, { contact, action }, { wixContactId, syncId, sourceUpdatedAt, properties }) {
  saveContactMapping(db, { wixContactId, hubspotContactId: contact.id, syncId, source: "wix", sourceUpdatedAt });
  return logEvent(db, {
    source: "wix",
    syncId,
    message: `Wix contact ${action} HubSpot contact.`,
    details: { wixContactId, hubspotContactId: contact.id, sourceUpdatedAt, properties }
  });
}

function finishHubSpotToWix(db, { contact, action }, { hubspotContactId, syncId, sourceUpdatedAt, fields }) {
  saveContactMapping(db, { wixContactId: contact.id, hubspotContactId, syncId, source: "hubspot", sourceUpdatedAt });
  return logEvent(db, {
    source: "hubspot",
    syncId,
    message: `HubSpot contact ${action} Wix contact.`,
    details: { wixContactId: contact.id, hubspotContactId, sourceUpdatedAt, fields }
  });
}

function outboundMetadata(syncId, timestamp) {
  return {
    wix_hubspot_origin: APP_ORIGIN,
    wix_hubspot_sync_id: syncId,
    wix_hubspot_synced_at: timestamp
  };
}

function sameMappedValues(current = {}, next = {}) {
  return Object.entries(next).every(([key, value]) => String(current[key] ?? "") === String(value ?? ""));
}

function existingMockHubSpot(db, mapping, properties) {
  return (
    (mapping?.hubspotContactId && db.mockHubSpotContacts?.find((contact) => contact.id === mapping.hubspotContactId)) ||
    (properties.email && db.mockHubSpotContacts?.find((contact) => contact.properties?.email === properties.email))
  );
}

function existingMockWix(db, mapping, fields) {
  return (
    (mapping?.wixContactId && db.mockWixContacts?.find((contact) => contact.id === mapping.wixContactId)) ||
    (fields.email && db.mockWixContacts?.find((contact) => contact.fields?.email === fields.email))
  );
}

function isTransientError(error) {
  return error?.statusCode === 429 || error?.statusCode >= 500;
}

function retryDelayMs(attempts) {
  return Math.min(60 * 60 * 1000, 2 ** Math.max(0, attempts) * 30_000);
}

function upsertRetryJob(db, { direction, syncId, payload, error }) {
  db.retryJobs = db.retryJobs || [];
  const existing = db.retryJobs.find((job) => job.syncId === syncId && job.direction === direction);
  const timestamp = now();
  const attempts = (existing?.attempts || 0) + 1;
  const transient = isTransientError(error);
  const status = transient && attempts < MAX_RETRY_ATTEMPTS ? "pending" : "failed";
  const job = existing || {
    id: id("retry"),
    direction,
    syncId,
    payload,
    createdAt: timestamp
  };
  job.status = status;
  job.attempts = attempts;
  job.nextAttemptAt = status === "pending" ? new Date(Date.now() + retryDelayMs(attempts)).toISOString() : null;
  job.lastError = error?.message || "Sync failed.";
  job.permanent = !transient || attempts >= MAX_RETRY_ATTEMPTS;
  job.payload = payload;
  job.updatedAt = timestamp;
  if (!existing) db.retryJobs.unshift(job);
  db.retryJobs = db.retryJobs.slice(0, 100);
  return job;
}

function handleSyncError(db, { direction, source, syncId, payload, error }) {
  const retryJob = upsertRetryJob(db, { direction, syncId, payload, error });
  return logEvent(db, {
    source,
    syncId,
    status: retryJob.status === "pending" ? "retry_pending" : "failed",
    message:
      retryJob.status === "pending"
        ? "Sync failed with a transient provider error and was queued for retry."
        : "Sync failed with a permanent provider error.",
    details: {
      retryJobId: retryJob.id,
      attempts: retryJob.attempts,
      nextAttemptAt: retryJob.nextAttemptAt,
      error: retryJob.lastError
    }
  });
}

function markRetryJobComplete(db, direction, syncId) {
  const job = (db.retryJobs || []).find((item) => item.direction === direction && item.syncId === syncId);
  if (!job) return;
  job.status = "succeeded";
  job.nextAttemptAt = null;
  job.updatedAt = now();
}

export function syncWixContactToHubSpot(db, payload, options = {}) {
  const adapters = options.adapters || createAdapters();
  const syncId = syncIdFromPayload(payload, "corr");
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

  if (hasProcessedEvent(db, syncId) || mapping?.processedSyncIds?.includes(syncId) || mapping?.lastSyncId === syncId) {
    return logEvent(db, {
      source: "wix",
      syncId,
      status: "skipped",
      message: "Ignored duplicate Wix event with same syncId.",
      details: { wixContactId, hubspotContactId: mapping.hubspotContactId }
    });
  }

  if (isStaleComparedToSameSource(mapping, "wix", sourceUpdatedAt)) {
    return logEvent(db, {
      source: "wix",
      syncId,
      status: "skipped",
      message: "Skipped stale Wix update because a newer Wix timestamp was already accepted.",
      details: {
        wixContactId,
        hubspotContactId: mapping.hubspotContactId,
        wixUpdatedAt: sourceUpdatedAt,
        lastWixUpdatedAt: mapping.lastWixUpdatedAt
      }
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

  const mappedProperties = mapWixFieldsToHubSpot(payload.fields || payload, db.mappings);
  const existing = existingMockHubSpot(db, mapping, mappedProperties);
  if (existing && sameMappedValues(existing.properties, mappedProperties)) {
    saveContactMapping(db, {
      wixContactId,
      hubspotContactId: existing.id,
      syncId,
      source: "wix",
      sourceUpdatedAt
    });
    return logEvent(db, {
      source: "wix",
      syncId,
      status: "skipped",
      message: "Skipped Wix update because mapped HubSpot values are unchanged.",
      details: { wixContactId, hubspotContactId: existing.id }
    });
  }

  const properties = { ...mappedProperties, ...outboundMetadata(syncId, now()) };
  const result = adapters.hubspot.upsertContact(
    db,
    properties,
    mapping?.hubspotContactId,
    sourceUpdatedAt
  );
  if (typeof result?.then === "function") {
    return result
      .then((resolved) => {
        markRetryJobComplete(db, "wix-to-hubspot", syncId);
        return finishWixToHubSpot(db, resolved, { wixContactId, syncId, sourceUpdatedAt, properties });
      })
      .catch((error) =>
        handleSyncError(db, { direction: "wix-to-hubspot", source: "wix", syncId, payload, error })
      );
  }
  markRetryJobComplete(db, "wix-to-hubspot", syncId);
  return finishWixToHubSpot(db, result, { wixContactId, syncId, sourceUpdatedAt, properties });
}

export function syncHubSpotContactToWix(db, payload, options = {}) {
  const adapters = options.adapters || createAdapters();
  const syncId = syncIdFromPayload(payload, "corr");
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

  if (hasProcessedEvent(db, syncId) || mapping?.processedSyncIds?.includes(syncId) || mapping?.lastSyncId === syncId) {
    return logEvent(db, {
      source: "hubspot",
      syncId,
      status: "skipped",
      message: "Ignored duplicate HubSpot event with same syncId.",
      details: { wixContactId: mapping.wixContactId, hubspotContactId }
    });
  }

  if (isStaleComparedToSameSource(mapping, "hubspot", sourceUpdatedAt)) {
    return logEvent(db, {
      source: "hubspot",
      syncId,
      status: "skipped",
      message: "Skipped stale HubSpot update because a newer HubSpot timestamp was already accepted.",
      details: {
        wixContactId: mapping.wixContactId,
        hubspotContactId,
        hubSpotUpdatedAt: sourceUpdatedAt,
        lastHubSpotUpdatedAt: mapping.lastHubSpotUpdatedAt
      }
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

  const mappedFields = mapHubSpotPropertiesToWix(payload.properties || payload, db.mappings);
  const existing = existingMockWix(db, mapping, mappedFields);
  if (existing && sameMappedValues(existing.fields, mappedFields)) {
    saveContactMapping(db, {
      wixContactId: existing.id,
      hubspotContactId,
      syncId,
      source: "hubspot",
      sourceUpdatedAt
    });
    return logEvent(db, {
      source: "hubspot",
      syncId,
      status: "skipped",
      message: "Skipped HubSpot update because mapped Wix values are unchanged.",
      details: { wixContactId: existing.id, hubspotContactId }
    });
  }

  const fields = { ...mappedFields, ...outboundMetadata(syncId, now()) };
  const result = adapters.wix.upsertContact(db, fields, mapping?.wixContactId, sourceUpdatedAt);
  if (typeof result?.then === "function") {
    return result
      .then((resolved) => {
        markRetryJobComplete(db, "hubspot-to-wix", syncId);
        return finishHubSpotToWix(db, resolved, { hubspotContactId, syncId, sourceUpdatedAt, fields });
      })
      .catch((error) =>
        handleSyncError(db, { direction: "hubspot-to-wix", source: "hubspot", syncId, payload, error })
      );
  }
  markRetryJobComplete(db, "hubspot-to-wix", syncId);
  return finishHubSpotToWix(db, result, { hubspotContactId, syncId, sourceUpdatedAt, fields });
}

export async function processDueRetryJobs(db, options = {}) {
  const dueJobs = (db.retryJobs || []).filter((job) => {
    return job.status === "pending" && (!job.nextAttemptAt || new Date(job.nextAttemptAt).getTime() <= Date.now());
  });
  const events = [];
  for (const job of dueJobs) {
    job.status = "running";
    job.updatedAt = now();
    const event =
      job.direction === "wix-to-hubspot"
        ? await syncWixContactToHubSpot(db, job.payload, options)
        : await syncHubSpotContactToWix(db, job.payload, options);
    events.push(event);
  }
  return events;
}

function hubSpotPollingCheckpoint(db) {
  db.pollingCheckpoints = db.pollingCheckpoints || [];
  let checkpoint = db.pollingCheckpoints.find((item) => item.provider === "hubspot");
  if (!checkpoint) {
    checkpoint = {
      provider: "hubspot",
      siteId: db.connection?.siteId || "default-site",
      status: "idle",
      lastPollStartedAt: null,
      lastPollCompletedAt: null,
      lastSuccessfulPollAt: null,
      lastModifiedAfter: null,
      lastSeenModifiedAt: null,
      nextAfter: null,
      lastError: null,
      updatedAt: now()
    };
    db.pollingCheckpoints.push(checkpoint);
  }
  return checkpoint;
}

function initialHubSpotPollSince(env = process.env) {
  const minutes = Number(env.HUBSPOT_POLL_INITIAL_LOOKBACK_MINUTES || DEFAULT_HUBSPOT_POLL_LOOKBACK_MINUTES);
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

export async function processHubSpotPollingFallback(db, options = {}) {
  const adapters = options.adapters || createAdapters();
  if (!adapters.hubspot.pollUpdatedContacts) {
    const error = new Error("The active HubSpot adapter does not support polling.");
    error.statusCode = 400;
    throw error;
  }

  const checkpoint = hubSpotPollingCheckpoint(db);
  const startedAt = now();
  const env = options.env || process.env;
  const since = options.since || checkpoint.lastSeenModifiedAt || checkpoint.lastModifiedAfter || initialHubSpotPollSince(env);
  const maxPages = Number(options.maxPages || env.HUBSPOT_POLL_MAX_PAGES || DEFAULT_HUBSPOT_POLL_MAX_PAGES);
  checkpoint.status = "running";
  checkpoint.lastPollStartedAt = startedAt;
  checkpoint.nextAfter = null;
  checkpoint.updatedAt = startedAt;

  try {
    const events = [];
    let contactCount = 0;
    let maxModifiedAt = since;
    let nextAfter = options.after || null;
    let pages = 0;

    do {
      pages += 1;
      checkpoint.nextAfter = nextAfter;
      const page = await adapters.hubspot.pollUpdatedContacts(db, {
        since,
        limit: options.limit,
        properties: options.properties,
        after: nextAfter
      });
      const contacts = Array.isArray(page) ? page : page.contacts || [];
      contactCount += contacts.length;

      for (const contact of contacts) {
        const updatedAt = normalizeTimestamp(
          contact.updatedAt ||
            contact.properties?.lastmodifieddate ||
            contact.properties?.hs_lastmodifieddate ||
            contact.updatedAt
        );
        if (isAfter(updatedAt, maxModifiedAt)) maxModifiedAt = updatedAt;
        events.push(
          await syncHubSpotContactToWix(
            db,
            {
              hubspotContactId: String(contact.id),
              syncId: `hubspot_poll_${contact.id}_${new Date(updatedAt).getTime()}`,
              updatedAt,
              properties: contact.properties || contact
            },
            options
          )
        );
      }

      nextAfter = Array.isArray(page) ? null : page.nextAfter || null;
    } while (nextAfter && pages < maxPages);

    if (nextAfter) {
      const error = new Error("HubSpot polling stopped before all pages were processed. Increase HUBSPOT_POLL_MAX_PAGES.");
      error.statusCode = 429;
      error.nextAfter = nextAfter;
      throw error;
    }

    const completedAt = now();
    checkpoint.status = "success";
    checkpoint.lastPollCompletedAt = completedAt;
    checkpoint.lastSuccessfulPollAt = completedAt;
    checkpoint.lastModifiedAfter = since;
    checkpoint.lastSeenModifiedAt = maxModifiedAt;
    checkpoint.nextAfter = null;
    checkpoint.lastError = null;
    checkpoint.updatedAt = completedAt;
    logEvent(db, {
      source: "system",
      syncId: id("poll"),
      message: "Completed HubSpot polling fallback.",
      details: { provider: "hubspot", since, contacts: contactCount, pages, lastSeenModifiedAt: maxModifiedAt }
    });
    return { checkpoint, events };
  } catch (error) {
    checkpoint.status = "failed";
    checkpoint.lastPollCompletedAt = now();
    checkpoint.lastError = error.message || "HubSpot polling failed.";
    checkpoint.nextAfter = error.nextAfter || checkpoint.nextAfter || null;
    checkpoint.updatedAt = checkpoint.lastPollCompletedAt;
    logEvent(db, {
      source: "system",
      syncId: id("poll"),
      status: "failed",
      message: "HubSpot polling fallback failed.",
      details: { provider: "hubspot", since, error: checkpoint.lastError }
    });
    throw error;
  }
}
