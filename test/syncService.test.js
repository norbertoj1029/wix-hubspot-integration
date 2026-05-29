import assert from "node:assert/strict";
import test from "node:test";
import { AdapterHttpError } from "../src/adapters/adapterErrors.js";
import { defaultMappings } from "../src/config/defaultMappings.js";
import { syncHubSpotContactToWix, syncWixContactToHubSpot } from "../src/services/syncService.js";

function createDb() {
  return {
    mappings: structuredClone(defaultMappings),
    contactMappings: [],
    syncEvents: [],
    formSubmissions: [],
    retryJobs: [],
    mockHubSpotContacts: [],
    mockWixContacts: []
  };
}

test("Wix contact sync creates and updates the same mapped HubSpot contact", () => {
  const db = createDb();

  const created = syncWixContactToHubSpot(db, {
    wixContactId: "wix_1",
    updatedAt: "2026-05-28T10:00:00.000Z",
    fields: { email: "TEST@EXAMPLE.COM", firstName: " Test ", company: "Acme" }
  });

  const updated = syncWixContactToHubSpot(db, {
    wixContactId: "wix_1",
    updatedAt: "2026-05-28T10:05:00.000Z",
    fields: { email: "test@example.com", firstName: "Updated", company: "Acme" }
  });

  assert.equal(created.status, "success");
  assert.equal(updated.message, "Wix contact updated HubSpot contact.");
  assert.equal(db.contactMappings.length, 1);
  assert.equal(db.mockHubSpotContacts.length, 1);
  assert.equal(db.mockHubSpotContacts[0].properties.email, "test@example.com");
  assert.equal(db.mockHubSpotContacts[0].properties.firstname, "Updated");
});

test("HubSpot update older than accepted Wix update is skipped", () => {
  const db = createDb();

  const created = syncWixContactToHubSpot(db, {
    wixContactId: "wix_2",
    updatedAt: "2026-05-28T12:00:00.000Z",
    fields: { email: "conflict@example.com", firstName: "Fresh" }
  });

  const skipped = syncHubSpotContactToWix(db, {
    hubspotContactId: created.details.hubspotContactId,
    updatedAt: "2026-05-28T11:00:00.000Z",
    properties: { email: "conflict@example.com", firstname: "Stale" }
  });

  assert.equal(skipped.status, "skipped");
  assert.match(skipped.message, /Skipped stale HubSpot update/);
  assert.equal(db.mockWixContacts.length, 0);
});

test("self-produced HubSpot webhook is ignored by origin tag", () => {
  const db = createDb();

  const skipped = syncHubSpotContactToWix(db, {
    hubspotContactId: "hs_self",
    origin: "wix-hubspot-integration",
    properties: { email: "self@example.com", firstname: "Self" }
  });

  assert.equal(skipped.status, "skipped");
  assert.match(skipped.message, /produced by this integration/);
  assert.equal(db.mockWixContacts.length, 0);
});

test("echo webhook with outbound sync metadata is ignored", () => {
  const db = createDb();

  const skipped = syncHubSpotContactToWix(db, {
    hubspotContactId: "hs_echo",
    properties: {
      email: "echo@example.com",
      firstname: "Echo",
      wix_hubspot_origin: "wix-hubspot-integration",
      wix_hubspot_sync_id: "sync_echo"
    }
  });

  assert.equal(skipped.status, "skipped");
  assert.match(skipped.message, /produced by this integration/);
  assert.equal(db.mockWixContacts.length, 0);
});

test("older processed syncIds are skipped even after a newer syncId", () => {
  const db = createDb();

  syncWixContactToHubSpot(db, {
    wixContactId: "wix_replay",
    syncId: "sync_001",
    updatedAt: "2026-05-28T10:00:00.000Z",
    fields: { email: "replay@example.com", firstName: "Original" }
  });

  syncWixContactToHubSpot(db, {
    wixContactId: "wix_replay",
    syncId: "sync_002",
    updatedAt: "2026-05-28T10:05:00.000Z",
    fields: { email: "replay@example.com", firstName: "Updated" }
  });

  const replayed = syncWixContactToHubSpot(db, {
    wixContactId: "wix_replay",
    syncId: "sync_001",
    updatedAt: "2026-05-28T10:10:00.000Z",
    fields: { email: "replay@example.com", firstName: "Replayed" }
  });

  assert.equal(replayed.status, "skipped");
  assert.match(replayed.message, /duplicate Wix event/);
  assert.deepEqual(db.contactMappings[0].processedSyncIds, ["sync_001", "sync_002"]);
  assert.equal(db.mockHubSpotContacts[0].properties.firstname, "Updated");
});

test("older Wix event with a different syncId cannot overwrite newer Wix data", () => {
  const db = createDb();

  syncWixContactToHubSpot(db, {
    wixContactId: "wix_same_source",
    syncId: "wix_newer",
    updatedAt: "2026-05-28T10:10:00.000Z",
    fields: { email: "same-wix@example.com", firstName: "Newer" }
  });

  const skipped = syncWixContactToHubSpot(db, {
    wixContactId: "wix_same_source",
    syncId: "wix_older_different",
    updatedAt: "2026-05-28T10:00:00.000Z",
    fields: { email: "same-wix@example.com", firstName: "Older" }
  });

  assert.equal(skipped.status, "skipped");
  assert.match(skipped.message, /newer Wix timestamp/);
  assert.equal(db.mockHubSpotContacts[0].properties.firstname, "Newer");
});

test("older HubSpot event with a different syncId cannot overwrite newer HubSpot data", () => {
  const db = createDb();

  syncHubSpotContactToWix(db, {
    hubspotContactId: "hs_same_source",
    syncId: "hs_newer",
    updatedAt: "2026-05-28T10:10:00.000Z",
    properties: { email: "same-hs@example.com", firstname: "Newer" }
  });

  const skipped = syncHubSpotContactToWix(db, {
    hubspotContactId: "hs_same_source",
    syncId: "hs_older_different",
    updatedAt: "2026-05-28T10:00:00.000Z",
    properties: { email: "same-hs@example.com", firstname: "Older" }
  });

  assert.equal(skipped.status, "skipped");
  assert.match(skipped.message, /newer HubSpot timestamp/);
  assert.equal(db.mockWixContacts[0].fields.firstName, "Newer");
});

test("UTM and page attribution fields map to HubSpot properties", () => {
  const db = createDb();

  const event = syncWixContactToHubSpot(db, {
    wixContactId: "wix_form_1",
    fields: {
      email: "lead@example.com",
      firstName: "Lead",
      utm_source: "google",
      utm_medium: "cpc",
      utm_campaign: "launch",
      pageUrl: "https://example.com/contact",
      referrer: "https://google.com"
    }
  });

  assert.equal(event.details.properties.wix_utm_source, "google");
  assert.equal(event.details.properties.wix_utm_medium, "cpc");
  assert.equal(event.details.properties.wix_utm_campaign, "launch");
  assert.equal(event.details.properties.wix_page_url, "https://example.com/contact");
  assert.equal(event.details.properties.wix_referrer, "https://google.com");
});

test("outbound writes include origin and correlation metadata", () => {
  const db = createDb();

  syncWixContactToHubSpot(db, {
    wixContactId: "wix_origin",
    syncId: "sync_origin",
    fields: { email: "origin@example.com", firstName: "Origin" }
  });

  assert.equal(db.mockHubSpotContacts[0].properties.wix_hubspot_origin, "wix-hubspot-integration");
  assert.equal(db.mockHubSpotContacts[0].properties.wix_hubspot_sync_id, "sync_origin");
  assert.match(db.mockHubSpotContacts[0].properties.wix_hubspot_synced_at, /^\d{4}-/);
});

test("identical mapped values are skipped instead of rewritten", () => {
  const db = createDb();

  syncWixContactToHubSpot(db, {
    wixContactId: "wix_same_values",
    syncId: "sync_same_values_1",
    updatedAt: "2026-05-28T10:00:00.000Z",
    fields: { email: "same-values@example.com", firstName: "Same" }
  });
  const skipped = syncWixContactToHubSpot(db, {
    wixContactId: "wix_same_values",
    syncId: "sync_same_values_2",
    updatedAt: "2026-05-28T10:05:00.000Z",
    fields: { email: "same-values@example.com", firstName: "Same" }
  });

  assert.equal(skipped.status, "skipped");
  assert.match(skipped.message, /unchanged/);
});

test("failed transient sync write creates a retry job", async () => {
  const db = createDb();
  const adapters = {
    hubspot: {
      async upsertContact() {
        throw new AdapterHttpError("HubSpot rate limit exceeded.", 429);
      }
    }
  };

  const event = await syncWixContactToHubSpot(
    db,
    {
      wixContactId: "wix_retry",
      syncId: "sync_retry",
      fields: { email: "retry@example.com", firstName: "Retry" }
    },
    { adapters }
  );

  assert.equal(event.status, "retry_pending");
  assert.equal(db.retryJobs.length, 1);
  assert.equal(db.retryJobs[0].direction, "wix-to-hubspot");
  assert.equal(db.retryJobs[0].permanent, false);
});
