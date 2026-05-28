/**
 * HubSpot adapter contract used by the sync service.
 *
 * @typedef {object} HubSpotAdapter
 * @property {(db: object, properties: object, existingHubSpotId?: string, sourceUpdatedAt?: string) => { contact: object, action: "created" | "updated" }} upsertContact
 */

/**
 * Wix adapter contract used by the sync service.
 *
 * @typedef {object} WixAdapter
 * @property {(db: object, fields: object, existingWixId?: string, sourceUpdatedAt?: string) => { contact: object, action: "created" | "updated" }} upsertContact
 */

export function assertAdapterContract(adapter, name) {
  if (!adapter || typeof adapter.upsertContact !== "function") {
    throw new TypeError(`${name} adapter must implement upsertContact.`);
  }
  return adapter;
}
