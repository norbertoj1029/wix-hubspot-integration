import { AdapterNotConfiguredError } from "./adapterErrors.js";

export function createRealWixAdapter(env = process.env) {
  return {
    upsertContact() {
      if (!env.WIX_API_KEY || !env.WIX_SITE_ID) {
        throw new AdapterNotConfiguredError(
          "Real Wix adapter is not configured. Set WIX_API_KEY and WIX_SITE_ID after wiring production Wix APIs."
        );
      }
      throw new AdapterNotConfiguredError(
        "Real Wix adapter boundary exists, but Wix API calls are intentionally not implemented in this mock demo."
      );
    }
  };
}
