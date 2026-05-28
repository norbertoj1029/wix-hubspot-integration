const WIX_OAUTH_BASE_URL = "https://www.wixapis.com";
const WIX_ACCESS_TOKEN_TTL_MS = 4 * 60 * 60 * 1000;

function wixOAuthBaseUrl(env) {
  return env.WIX_OAUTH_BASE_URL || env.WIX_API_BASE_URL || WIX_OAUTH_BASE_URL;
}

function expiresAtFromPayload(payload) {
  const expiresIn = Number(payload.expires_in || payload.expiresIn || 0);
  if (expiresIn > 0) return new Date(Date.now() + expiresIn * 1000).toISOString();
  return new Date(Date.now() + WIX_ACCESS_TOKEN_TTL_MS).toISOString();
}

async function parseWixTokenResponse(response) {
  const payload = await response.json().catch(() => ({}));
  if (payload.body && typeof payload.body === "string") {
    return JSON.parse(payload.body);
  }
  return payload;
}

function normalizeWixToken(payload) {
  return {
    accessToken: payload.access_token || payload.accessToken,
    refreshToken: payload.refresh_token || payload.refreshToken || null,
    expiresAt: payload.expiresAt || payload.expires_at || expiresAtFromPayload(payload),
    tokenType: payload.token_type || payload.tokenType || "bearer"
  };
}

export async function createWixAccessToken(env, { instanceId }) {
  if (!env.WIX_APP_ID || !env.WIX_APP_SECRET || !instanceId) {
    const error = new Error("WIX_APP_ID, WIX_APP_SECRET, and a Wix instance ID are required.");
    error.statusCode = 500;
    throw error;
  }

  const response = await fetch(`${wixOAuthBaseUrl(env)}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: env.WIX_APP_ID,
      client_secret: env.WIX_APP_SECRET,
      instance_id: instanceId
    })
  });
  const payload = await parseWixTokenResponse(response);
  if (!response.ok || !normalizeWixToken(payload).accessToken) {
    const error = new Error(payload.message || payload.error_description || payload.error || "Wix OAuth token creation failed.");
    error.statusCode = response.status || 502;
    throw error;
  }
  return normalizeWixToken(payload);
}

export async function exchangeWixInstallToken(env, { instanceToken, siteId, installId }) {
  if (env.WIX_APP_ID && env.WIX_APP_SECRET && installId) {
    return createWixAccessToken(env, { instanceId: installId });
  }

  if (env.WIX_INSTALL_TOKEN_EXCHANGE_URL) {
    const response = await fetch(env.WIX_INSTALL_TOKEN_EXCHANGE_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(env.WIX_INSTALL_TOKEN_EXCHANGE_API_KEY
          ? { authorization: `Bearer ${env.WIX_INSTALL_TOKEN_EXCHANGE_API_KEY}` }
          : {})
      },
      body: JSON.stringify({ instanceToken, siteId, installId })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.accessToken) {
      const error = new Error(payload.message || payload.error || "Wix install token exchange failed.");
      error.statusCode = response.status || 502;
      throw error;
    }
    return {
      accessToken: payload.accessToken,
      refreshToken: payload.refreshToken || payload.refresh_token || null,
      expiresAt: payload.expiresAt || payload.expires_at || null,
      tokenType: payload.tokenType || payload.token_type || "bearer"
    };
  }

  if (env.WIX_ACCESS_TOKEN) {
    return {
      accessToken: env.WIX_ACCESS_TOKEN,
      refreshToken: null,
      expiresAt: null,
      tokenType: "bearer"
    };
  }

  const error = new Error(
    "No Wix token exchange is configured. Set WIX_APP_ID/WIX_APP_SECRET, WIX_INSTALL_TOKEN_EXCHANGE_URL, or WIX_ACCESS_TOKEN."
  );
  error.statusCode = 500;
  throw error;
}

export async function ensureWixAccessToken(db, env = process.env) {
  const expiresAt = db.connection?.wixTokenExpiresAt ? new Date(db.connection.wixTokenExpiresAt).getTime() : null;
  const hasUsableStoredToken =
    db.connection?.wixAccessToken && (!expiresAt || expiresAt > Date.now() + 60_000);
  if (hasUsableStoredToken) return db.connection.wixAccessToken;

  const instanceId = db.connection?.installId || env.WIX_INSTANCE_ID;
  if (env.WIX_APP_ID && env.WIX_APP_SECRET && instanceId) {
    const token = await createWixAccessToken(env, { instanceId });
    db.connection = {
      ...(db.connection || {}),
      wixAccessToken: token.accessToken,
      wixRefreshToken: token.refreshToken,
      wixTokenExpiresAt: token.expiresAt,
      wixTokenType: token.tokenType
    };
    return token.accessToken;
  }

  if (db.connection?.wixAccessToken) return db.connection.wixAccessToken;
  if (env.WIX_ACCESS_TOKEN) return env.WIX_ACCESS_TOKEN;

  const error = new Error("Real Wix adapter is not configured with an access token or OAuth app credentials.");
  error.statusCode = 401;
  throw error;
}
