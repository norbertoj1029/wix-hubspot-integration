import crypto from "node:crypto";

function timingSafeEqual(left, right) {
  const leftBuffer = Buffer.from(left || "");
  const rightBuffer = Buffer.from(right || "");
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function verifyHubSpotWebhookSignature({ method, url, rawBody, headers, clientSecret, baseUrl }) {
  if (!clientSecret) return false;
  const signature = headers["x-hubspot-signature-v3"] || headers["x-hubspot-signature"];
  if (!signature) return false;

  if (headers["x-hubspot-signature-v3"]) {
    const timestamp = headers["x-hubspot-request-timestamp"];
    if (!timestamp || Math.abs(Date.now() - Number(timestamp)) > 5 * 60 * 1000) return false;
    const absoluteUrl = new URL(url, baseUrl).toString();
    const source = `${method}${absoluteUrl}${rawBody}${timestamp}`;
    const expected = crypto.createHmac("sha256", clientSecret).update(source).digest("base64");
    return timingSafeEqual(signature, expected);
  }

  const expected = crypto.createHash("sha256").update(`${clientSecret}${rawBody}`).digest("hex");
  return timingSafeEqual(signature, expected);
}

export function verifyWixWebhookSignature({ rawBody, headers, secret }) {
  if (!secret) return false;
  const signature =
    headers["x-wix-signature"] ||
    headers["x-wix-webhook-signature"] ||
    headers["x-webhook-signature"];
  if (!signature) return false;

  const expectedBase64 = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  const expectedHex = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return timingSafeEqual(signature, expectedBase64) || timingSafeEqual(signature, expectedHex);
}
