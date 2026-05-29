import { AdapterHttpError, AdapterNotConfiguredError } from "./adapterErrors.js";
import { ensureWixAccessToken } from "../services/wixInstall.js";

const WIX_API_BASE_URL = "https://www.wixapis.com";

function toWixContactPayload(fields) {
  return {
    info: {
      name: {
        first: fields.firstName,
        last: fields.lastName
      },
      emails: fields.email ? [{ email: fields.email, primary: true }] : [],
      phones: fields.phone ? [{ phone: fields.phone, primary: true }] : [],
      company: fields.company,
      extendedFields: {
        items: Object.fromEntries(
          Object.entries(fields || {}).filter(
            ([key]) => !["email", "firstName", "lastName", "phone", "company"].includes(key)
          )
        )
      }
    }
  };
}

function fromWixContact(contact, fallback = {}) {
  const info = contact.info || {};
  return {
    id: contact.id || contact._id,
    fields: {
      email: info.emails?.[0]?.email || fallback.email,
      firstName: info.name?.first || fallback.firstName,
      lastName: info.name?.last || fallback.lastName,
      phone: info.phones?.[0]?.phone || fallback.phone,
      company: info.company || fallback.company,
      ...(info.extendedFields?.items || {})
    },
    updatedAt: contact.updatedDate || contact._updatedDate || fallback.updatedAt
  };
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function wixToken(db, env) {
  try {
    return await ensureWixAccessToken(db, env);
  } catch {
    throw new AdapterNotConfiguredError(
      "Real Wix adapter is not configured. Set WIX_APP_ID/WIX_APP_SECRET, WIX_ACCESS_TOKEN, or store a Wix site access token."
    );
  }
}

async function wixHeaders(db, env) {
  return {
    authorization: `Bearer ${await wixToken(db, env)}`,
    "content-type": "application/json",
    ...(db.connection?.siteId || env.WIX_SITE_ID ? { "wix-site-id": db.connection?.siteId || env.WIX_SITE_ID } : {})
  };
}

async function wixRequest(db, env, path, options = {}) {
  const response = await fetch(`${env.WIX_API_BASE_URL || WIX_API_BASE_URL}${path}`, {
    ...options,
    headers: {
      ...(await wixHeaders(db, env)),
      ...(options.headers || {})
    }
  });
  const payload = await parseResponse(response);
  if (!response.ok) {
    const message =
      response.status === 401
        ? "Wix authorization failed."
        : response.status === 403
          ? "Wix token does not have permission for this site."
          : response.status === 404
            ? "Wix contact was not found."
            : response.status === 429
              ? "Wix rate limit exceeded. Retry later."
              : payload.message || payload.error || "Wix API request failed.";
    throw new AdapterHttpError(message, response.status, { details: payload.details });
  }
  return payload;
}

async function readContact(db, env, wixContactId) {
  if (!wixContactId) return null;
  return wixRequest(db, env, `/contacts/v4/contacts/${encodeURIComponent(wixContactId)}`, {
    method: "GET"
  })
    .then((payload) => payload.contact || payload)
    .catch((error) => {
      if (error.statusCode === 404) return null;
      throw error;
    });
}

async function searchContactByEmail(db, env, email) {
  if (!email) return null;
  const payload = await wixRequest(db, env, "/contacts/v4/contacts/query", {
    method: "POST",
    body: JSON.stringify({
      query: {
        filter: { "info.emails.email": { $eq: email } },
        paging: { limit: 1 }
      }
    })
  }).catch((error) => {
    if (error.statusCode === 404) return {};
    throw error;
  });
  return payload.contacts?.[0] || null;
}

export function createRealWixAdapter(env = process.env) {
  return {
    async upsertContact(db, fields, existingWixId, sourceUpdatedAt) {
      const byId = await readContact(db, env, existingWixId);
      const byEmail = byId ? null : await searchContactByEmail(db, env, fields.email);
      const current = byId || byEmail;

      if (current) {
        const payload = await wixRequest(db, env, `/contacts/v4/contacts/${encodeURIComponent(current.id || current._id)}`, {
          method: "PATCH",
          body: JSON.stringify({ contact: toWixContactPayload(fields) })
        });
        return {
          contact: { ...fromWixContact(payload.contact || payload, fields), updatedAt: sourceUpdatedAt },
          action: "updated"
        };
      }

      const payload = await wixRequest(db, env, "/contacts/v4/contacts", {
        method: "POST",
        body: JSON.stringify({ contact: toWixContactPayload(fields) })
      });
      return {
        contact: { ...fromWixContact(payload.contact || payload, fields), updatedAt: sourceUpdatedAt },
        action: "created"
      };
    },

    async listContactFields() {
      return [
        { name: "email", label: "Email" },
        { name: "firstName", label: "First name" },
        { name: "lastName", label: "Last name" },
        { name: "phone", label: "Phone" },
        { name: "company", label: "Company" },
        { name: "utm_source", label: "UTM source" },
        { name: "utm_medium", label: "UTM medium" },
        { name: "utm_campaign", label: "UTM campaign" },
        { name: "utm_term", label: "UTM term" },
        { name: "utm_content", label: "UTM content" },
        { name: "pageUrl", label: "Page URL" },
        { name: "referrer", label: "Referrer" }
      ];
    }
  };
}
