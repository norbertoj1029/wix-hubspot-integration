import crypto from "node:crypto";

function base64UrlDecode(value) {
  return Buffer.from(String(value).replaceAll("-", "+").replaceAll("_", "/"), "base64");
}

function parseJwt(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  try {
    return {
      header: JSON.parse(base64UrlDecode(parts[0]).toString("utf8")),
      payload: JSON.parse(base64UrlDecode(parts[1]).toString("utf8")),
      signingInput: `${parts[0]}.${parts[1]}`,
      signature: parts[2]
    };
  } catch {
    return null;
  }
}

function timingSafeEqualText(left, right) {
  const leftBuffer = Buffer.from(left || "");
  const rightBuffer = Buffer.from(right || "");
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyHs256(jwt, secret) {
  if (!jwt || !secret || jwt.header.alg !== "HS256") return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(jwt.signingInput)
    .digest("base64url");
  return timingSafeEqualText(jwt.signature, expected);
}

function pickContext(source = {}) {
  return {
    siteId: source.siteId || source.instanceId || source.site_id || source.metaSiteId,
    installId: source.installId || source.installationId || source.appInstanceId || source.instanceId
  };
}

export function getWixRequestContext(req, body = {}, env = process.env) {
  const authHeader = req.headers.authorization || "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
  const token = req.headers["x-wix-instance-token"] || req.headers["x-wix-app-token"] || bearer;
  const jwt = token ? parseJwt(token) : null;
  const verified = jwt ? verifyHs256(jwt, env.WIX_APP_SECRET || env.WIX_INSTANCE_SECRET) : false;
  const tokenContext = verified ? pickContext(jwt.payload) : {};

  return {
    verified,
    siteId: req.headers["x-wix-site-id"] || body.siteId || tokenContext.siteId,
    installId: req.headers["x-wix-installation-id"] || body.installId || tokenContext.installId
  };
}

export function assertSameInstallation(db, context, { requireVerified = false } = {}) {
  if (requireVerified && !context.verified) {
    const error = new Error("A signed Wix instance/app token is required for this route in real mode.");
    error.statusCode = 401;
    throw error;
  }

  const expectedSiteId = db.connection?.siteId;
  const expectedInstallId = db.connection?.installId;
  if (expectedSiteId && expectedSiteId !== "default-site" && context.siteId && expectedSiteId !== context.siteId) {
    const error = new Error("Request is not authorized for this Wix site.");
    error.statusCode = 403;
    throw error;
  }
  if (
    expectedInstallId &&
    expectedInstallId !== "default-installation" &&
    context.installId &&
    expectedInstallId !== context.installId
  ) {
    const error = new Error("Request is not authorized for this Wix installation.");
    error.statusCode = 403;
    throw error;
  }
}
