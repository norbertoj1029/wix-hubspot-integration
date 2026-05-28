import { id, now } from "../lib/time.js";

function samePayload(left, right) {
  return JSON.stringify(left || {}) === JSON.stringify(right || {});
}

export function upsertMockHubSpotContact(db, properties, existingHubSpotId, sourceUpdatedAt = now()) {
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
      contact.updatedAt = sourceUpdatedAt;
    }
    return { contact, action: "updated" };
  }

  const created = {
    id: id("hs"),
    properties,
    createdAt: sourceUpdatedAt,
    updatedAt: sourceUpdatedAt
  };
  db.mockHubSpotContacts.push(created);
  return { contact: created, action: "created" };
}
