import { AdapterNotConfiguredError } from "./adapterErrors.js";

export function createRealHubSpotAdapter(env = process.env) {
  return {
    upsertContact() {
      if (!env.HUBSPOT_ACCESS_TOKEN) {
        throw new AdapterNotConfiguredError(
          "Real HubSpot adapter is not configured. Set HUBSPOT_ACCESS_TOKEN after implementing OAuth token exchange."
        );
      }
      throw new AdapterNotConfiguredError(
        "Real HubSpot adapter boundary exists, but CRM API calls are intentionally not implemented in this mock demo."
      );
    }
  };
}
