import { assertAdapterContract } from "./clientInterfaces.js";
import { createMockHubSpotAdapter } from "./mockHubSpotAdapter.js";
import { createMockWixAdapter } from "./mockWixAdapter.js";
import { createRealHubSpotAdapter } from "./realHubSpotAdapter.js";
import { createRealWixAdapter } from "./realWixAdapter.js";

export function createHubSpotAdapter({ mode = "mock", env = process.env } = {}) {
  const adapter = mode === "real" ? createRealHubSpotAdapter(env) : createMockHubSpotAdapter();
  return assertAdapterContract(adapter, "HubSpot");
}

export function createWixAdapter({ mode = "mock", env = process.env } = {}) {
  const adapter = mode === "real" ? createRealWixAdapter(env) : createMockWixAdapter();
  return assertAdapterContract(adapter, "Wix");
}

export function createAdapters({ hubspotMode = "mock", wixMode = "mock", env = process.env } = {}) {
  return {
    hubspot: createHubSpotAdapter({ mode: hubspotMode, env }),
    wix: createWixAdapter({ mode: wixMode, env })
  };
}
