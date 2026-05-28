import assert from "node:assert/strict";
import test from "node:test";
import { defaultMappings } from "../src/config/defaultMappings.js";
import { syncHubSpotContactToWix, syncWixContactToHubSpot } from "../src/services/syncService.js";

function createDb() {
  return {
    mappings: structuredClone(defaultMappings),
    contactMappings: [],
    syncEvents: [],
    formSubmissions: [],
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
