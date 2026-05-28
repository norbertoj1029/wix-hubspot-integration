import crypto from "node:crypto";

const HUBSPOT_OAUTH_BASE_URL = "https://api.hubapi.com";

export const HUBSPOT_SCOPES = [
  "crm.objects.contacts.read",
  "crm.objects.contacts.write",
  "crm.schemas.contacts.read"
];

export function createOAuthState(db, { siteId, installId, redirectTo = "/" } = {}) {
  const state = crypto.randomBytes(24).toString("hex");
  db.oauthStates = db.oauthStates || [];
  db.oauthStates.push({
    state,
    siteId: siteId || "default-site",
    installId: installId || "default-installation",
    redirectTo,
    createdAt: new Date().toISOString(),
    consumedAt: null
  });
  return state;
}

export function consumeOAuthState(db, state) {
  const entry = (db.oauthStates || []).find((item) => item.state === state && !item.consumedAt);
  if (!entry) return null;

  const ageMs = Date.now() - new Date(entry.createdAt).getTime();
  if (ageMs > 10 * 60 * 1000) return null;

  entry.consumedAt = new Date().toISOString();
  return entry;
}

export function buildHubSpotAuthorizeUrl(env, state, baseUrl) {
  const clientId = env.HUBSPOT_CLIENT_ID;
  if (!clientId) {
    const error = new Error("HUBSPOT_CLIENT_ID is required for real HubSpot OAuth.");
    error.statusCode = 500;
    throw error;
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: env.HUBSPOT_REDIRECT_URI || `${baseUrl}/api/auth/hubspot/callback`,
    scope: HUBSPOT_SCOPES.join(" "),
    response_type: "code",
    state
  });
  return `https://app.hubspot.com/oauth/authorize?${params.toString()}`;
}

function tokenEndpoint(env) {
  return `${env.HUBSPOT_OAUTH_BASE_URL || HUBSPOT_OAUTH_BASE_URL}/oauth/v1/token`;
}

function assertOAuthConfig(env) {
  if (!env.HUBSPOT_CLIENT_ID || !env.HUBSPOT_CLIENT_SECRET) {
    const error = new Error("HUBSPOT_CLIENT_ID and HUBSPOT_CLIENT_SECRET are required.");
    error.statusCode = 500;
    throw error;
  }
}

export async function exchangeHubSpotCode(env, code, baseUrl) {
  assertOAuthConfig(env);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: env.HUBSPOT_CLIENT_ID,
    client_secret: env.HUBSPOT_CLIENT_SECRET,
    redirect_uri: env.HUBSPOT_REDIRECT_URI || `${baseUrl}/api/auth/hubspot/callback`,
    code
  });

  const response = await fetch(tokenEndpoint(env), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || payload.error_description || "HubSpot OAuth code exchange failed.");
    error.statusCode = response.status;
    throw error;
  }
  return normalizeHubSpotToken(payload);
}

export async function refreshHubSpotToken(env, refreshToken) {
  assertOAuthConfig(env);
  if (!refreshToken) {
    const error = new Error("No HubSpot refresh token is available.");
    error.statusCode = 401;
    throw error;
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: env.HUBSPOT_CLIENT_ID,
    client_secret: env.HUBSPOT_CLIENT_SECRET,
    refresh_token: refreshToken
  });

  const response = await fetch(tokenEndpoint(env), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || payload.error_description || "HubSpot token refresh failed.");
    error.statusCode = response.status;
    throw error;
  }
  return normalizeHubSpotToken({ ...payload, refresh_token: payload.refresh_token || refreshToken });
}

export async function revokeHubSpotRefreshToken(env, refreshToken) {
  if (!refreshToken) return;
  const baseUrl = env.HUBSPOT_OAUTH_BASE_URL || HUBSPOT_OAUTH_BASE_URL;
  await fetch(`${baseUrl}/oauth/v1/refresh-tokens/${encodeURIComponent(refreshToken)}`, {
    method: "DELETE"
  }).catch(() => {});
}

export function normalizeHubSpotToken(payload) {
  const expiresIn = Number(payload.expires_in || 1800);
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    tokenType: payload.token_type || "bearer",
    scope: payload.scope,
    portalId: payload.hub_id || payload.hubId || payload.portalId || null
  };
}

export async function ensureHubSpotAccessToken(db, env) {
  const tokens = db.connection?.tokens;
  if (!tokens?.accessToken) {
    const error = new Error("HubSpot is not connected.");
    error.statusCode = 401;
    throw error;
  }

  const expiresAt = new Date(tokens.expiresAt || 0).getTime();
  if (expiresAt > Date.now() + 60_000) return tokens.accessToken;

  const refreshed = await refreshHubSpotToken(env, tokens.refreshToken);
  db.connection.tokens = {
    ...tokens,
    ...refreshed,
    refreshToken: refreshed.refreshToken || tokens.refreshToken
  };
  db.connection.connected = true;
  db.connection.connectedAt = db.connection.connectedAt || new Date().toISOString();
  db.connection.portalId = refreshed.portalId || db.connection.portalId || null;
  return db.connection.tokens.accessToken;
}
