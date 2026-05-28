import { id, now } from "../lib/time.js";

export function upsertMockWixContact(db, fields, existingWixId, sourceUpdatedAt = now()) {
  const byId = existingWixId ? db.mockWixContacts.find((contact) => contact.id === existingWixId) : null;
  const byEmail = fields.email ? db.mockWixContacts.find((contact) => contact.fields.email === fields.email) : null;
  const contact = byId || byEmail;

  if (contact) {
    contact.fields = { ...contact.fields, ...fields };
    contact.updatedAt = sourceUpdatedAt;
    return { contact, action: "updated" };
  }

  const created = {
    id: id("wix"),
    fields,
    createdAt: sourceUpdatedAt,
    updatedAt: sourceUpdatedAt
  };
  db.mockWixContacts.push(created);
  return { contact: created, action: "created" };
}
