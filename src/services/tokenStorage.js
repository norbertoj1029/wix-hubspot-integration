import crypto from "node:crypto";

const TOKEN_STORAGE_VERSION = 1;

function keyFromEnv(env = process.env) {
  const raw = env.TOKEN_ENCRYPTION_KEY;
  if (!raw) return null;
  if (/^[a-f0-9]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  return crypto.createHash("sha256").update(raw).digest();
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function tokenStorageMode(env = process.env) {
  if (env.WIX_SECRET_MANAGER_TOKEN_JSON) return "wix-secret-manager";
  if (env.TOKEN_ENCRYPTION_KEY) return "encrypted";
  return "server-only";
}

export function encryptSecret(secret, env = process.env, secretName = "secret") {
  if (!secret) return null;

  if (env.WIX_SECRET_MANAGER_TOKEN_JSON) {
    return {
      storage: "wix-secret-manager",
      version: TOKEN_STORAGE_VERSION,
      secretName
    };
  }

  const key = keyFromEnv(env);
  if (!key) return secret;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(String(secret));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    storage: "encrypted",
    version: TOKEN_STORAGE_VERSION,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
}

export function decryptSecret(storedSecret, env = process.env, secretName = "secret") {
  if (!storedSecret) return null;

  if (typeof storedSecret === "string") return storedSecret;

  if (storedSecret.storage === "wix-secret-manager") {
    const rawSecret = env.WIX_SECRET_MANAGER_TOKEN_JSON;
    if (!rawSecret) return null;
    try {
      const parsed = JSON.parse(rawSecret);
      return typeof parsed === "string" ? parsed : parsed[secretName] || parsed.value || null;
    } catch {
      const error = new Error("WIX_SECRET_MANAGER_TOKEN_JSON is not valid JSON.");
      error.statusCode = 500;
      throw error;
    }
  }

  if (storedSecret.storage !== "encrypted") return storedSecret;

  const key = keyFromEnv(env);
  if (!key) {
    const error = new Error("TOKEN_ENCRYPTION_KEY is required to decrypt stored secrets.");
    error.statusCode = 500;
    throw error;
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(storedSecret.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(storedSecret.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(storedSecret.ciphertext, "base64")),
    decipher.final()
  ]);
  return plaintext.toString("utf8");
}

export function encryptTokens(tokens, env = process.env) {
  if (!tokens) return null;

  if (env.WIX_SECRET_MANAGER_TOKEN_JSON) {
    return {
      storage: "wix-secret-manager",
      version: TOKEN_STORAGE_VERSION,
      secretName: env.WIX_SECRET_MANAGER_TOKEN_NAME || "hubspot-oauth-tokens"
    };
  }

  const key = keyFromEnv(env);
  if (!key) return clone(tokens);

  const encrypted = encryptSecret(JSON.stringify(tokens), env);
  return encrypted && typeof encrypted === "object"
    ? { ...encrypted, contentType: "application/json" }
    : clone(tokens);
}

export function decryptTokens(storedTokens, env = process.env) {
  if (!storedTokens) return null;

  if (storedTokens.storage === "wix-secret-manager") {
    const rawSecret = env.WIX_SECRET_MANAGER_TOKEN_JSON;
    if (!rawSecret) return null;
    try {
      return JSON.parse(rawSecret);
    } catch {
      const error = new Error("WIX_SECRET_MANAGER_TOKEN_JSON is not valid JSON.");
      error.statusCode = 500;
      throw error;
    }
  }

  if (storedTokens.storage !== "encrypted") return clone(storedTokens);

  return JSON.parse(decryptSecret(storedTokens, env));
}

export function prepareDbForStorage(db, env = process.env) {
  const copy = clone(db);
  if (copy?.connection?.tokens) copy.connection.tokens = encryptTokens(copy.connection.tokens, env);
  if (copy?.connection?.wixAccessToken) {
    copy.connection.wixAccessToken = encryptSecret(
      copy.connection.wixAccessToken,
      env,
      env.WIX_SECRET_MANAGER_WIX_TOKEN_NAME || "wix-site-access-token"
    );
  }
  if (copy?.connection?.wixRefreshToken) {
    copy.connection.wixRefreshToken = encryptSecret(
      copy.connection.wixRefreshToken,
      env,
      env.WIX_SECRET_MANAGER_WIX_REFRESH_TOKEN_NAME || "wix-refresh-token"
    );
  }
  return copy;
}

export function prepareDbFromStorage(db, env = process.env) {
  const copy = clone(db);
  if (copy?.connection?.tokens) copy.connection.tokens = decryptTokens(copy.connection.tokens, env);
  if (copy?.connection?.wixAccessToken) {
    copy.connection.wixAccessToken = decryptSecret(
      copy.connection.wixAccessToken,
      env,
      env.WIX_SECRET_MANAGER_WIX_TOKEN_NAME || "wix-site-access-token"
    );
  }
  if (copy?.connection?.wixRefreshToken) {
    copy.connection.wixRefreshToken = decryptSecret(
      copy.connection.wixRefreshToken,
      env,
      env.WIX_SECRET_MANAGER_WIX_REFRESH_TOKEN_NAME || "wix-refresh-token"
    );
  }
  return copy;
}
