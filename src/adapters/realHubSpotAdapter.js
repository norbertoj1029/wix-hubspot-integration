import { AdapterHttpError } from "./adapterErrors.js";
import { ensureHubSpotAccessToken } from "../services/oauth.js";

const HUBSPOT_API_BASE_URL = "https://api.hubapi.com";

function sameValue(left, right) {
  return String(left ?? "") === String(right ?? "");
}

function changedProperties(current = {}, next = {}) {
  return Object.fromEntries(Object.entries(next).filter(([key, value]) => !sameValue(current[key], value)));
}

function normalizePropertyList(properties = []) {
  return [...new Set(properties.filter(Boolean))];
}

function defaultPollProperties(env) {
  return normalizePropertyList(
    (env.HUBSPOT_POLL_PROPERTIES || "email,firstname,lastname,phone,company,lastmodifieddate,hs_lastmodifieddate")
      .split(",")
      .map((property) => property.trim())
  );
}

function hubSpotMillis(value) {
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? String(Date.now() - 24 * 60 * 60 * 1000) : String(timestamp);
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

function cleanErrorMessage(status, payload) {
  if (status === 401) return "HubSpot authorization failed. Reconnect HubSpot.";
  if (status === 403) return "HubSpot token does not have the required scopes.";
  if (status === 404) return "HubSpot resource was not found.";
  if (status === 409) return "HubSpot contact conflict.";
  if (status === 429) return "HubSpot rate limit exceeded. Retry later.";
  if (status >= 500) return "HubSpot service error. Retry later.";
  return payload.message || payload.error || "HubSpot API request failed.";
}

async function hubspotRequest(db, env, path, options = {}, retry = true) {
  const accessToken = await ensureHubSpotAccessToken(db, env);
  const response = await fetch(`${env.HUBSPOT_API_BASE_URL || HUBSPOT_API_BASE_URL}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  const payload = await parseResponse(response);

  if (response.status === 401 && retry) {
    db.connection.tokens.expiresAt = "1970-01-01T00:00:00.000Z";
    return hubspotRequest(db, env, path, options, false);
  }

  if (!response.ok) {
    throw new AdapterHttpError(cleanErrorMessage(response.status, payload), response.status, {
      category: payload.category,
      correlationId: payload.correlationId
    });
  }

  return payload;
}

async function searchContactByEmail(db, env, email) {
  if (!email) return null;
  const payload = await hubspotRequest(db, env, "/crm/v3/objects/contacts/search", {
    method: "POST",
    body: JSON.stringify({
      filterGroups: [
        {
          filters: [{ propertyName: "email", operator: "EQ", value: email }]
        }
      ],
      properties: ["email", "firstname", "lastname", "phone", "company"],
      limit: 1
    })
  });
  return payload.results?.[0] || null;
}

async function readContact(db, env, hubspotContactId, properties) {
  if (!hubspotContactId) return null;
  const query = properties?.length ? `?properties=${encodeURIComponent(properties.join(","))}` : "";
  return hubspotRequest(db, env, `/crm/v3/objects/contacts/${encodeURIComponent(hubspotContactId)}${query}`, {
    method: "GET"
  }).catch((error) => {
    if (error.statusCode === 404) return null;
    throw error;
  });
}

export function createRealHubSpotAdapter(env = process.env) {
  return {
    async upsertContact(db, properties, existingHubSpotId, sourceUpdatedAt) {
      const propertyNames = [...new Set(Object.keys(properties || {}).concat(["email"]))];
      const byId = await readContact(db, env, existingHubSpotId, propertyNames);
      const byEmail = byId ? null : await searchContactByEmail(db, env, properties.email);
      const current = byId || byEmail;

      if (current) {
        const diff = changedProperties(current.properties, properties);
        if (Object.keys(diff).length > 0) {
          const updated = await hubspotRequest(
            db,
            env,
            `/crm/v3/objects/contacts/${encodeURIComponent(current.id)}`,
            {
              method: "PATCH",
              body: JSON.stringify({ properties: diff })
            }
          );
          return {
            contact: { id: updated.id, properties: { ...current.properties, ...diff }, updatedAt: sourceUpdatedAt },
            action: "updated"
          };
        }
        return {
          contact: { id: current.id, properties: current.properties || properties, updatedAt: sourceUpdatedAt },
          action: "unchanged"
        };
      }

      const created = await hubspotRequest(db, env, "/crm/v3/objects/contacts", {
        method: "POST",
        body: JSON.stringify({ properties })
      });
      return {
        contact: { id: created.id, properties: created.properties || properties, updatedAt: sourceUpdatedAt },
        action: "created"
      };
    },

    async listContactProperties(db) {
      const payload = await hubspotRequest(db, env, "/crm/v3/properties/contacts?archived=false", {
        method: "GET"
      });
      return (payload.results || []).map((property) => ({
        name: property.name,
        label: property.label,
        type: property.type,
        fieldType: property.fieldType
      }));
    },

    async getContact(db, hubspotContactId, properties) {
      const propertyNames = normalizePropertyList(
        properties?.length
          ? properties
          : [
              ...defaultPollProperties(env),
              ...(db.mappings || []).map((mapping) => mapping.hubspotProperty)
            ]
      );
      const contact = await readContact(db, env, hubspotContactId, propertyNames);
      if (!contact) return null;
      return {
        id: contact.id,
        properties: contact.properties || {},
        updatedAt:
          contact.properties?.lastmodifieddate ||
          contact.properties?.hs_lastmodifieddate ||
          contact.updatedAt
      };
    },

    async pollUpdatedContacts(db, { since, limit, properties, after } = {}) {
      const propertyNames = normalizePropertyList(
        properties?.length
          ? properties
          : [
              ...defaultPollProperties(env),
              ...(db.mappings || []).map((mapping) => mapping.hubspotProperty)
            ]
      );
      const payload = await hubspotRequest(db, env, "/crm/v3/objects/contacts/search", {
        method: "POST",
        body: JSON.stringify({
          filterGroups: [
            {
              filters: [
                {
                  propertyName: "lastmodifieddate",
                  operator: "GT",
                  value: hubSpotMillis(since)
                }
              ]
            }
          ],
          sorts: [{ propertyName: "lastmodifieddate", direction: "ASCENDING" }],
          properties: propertyNames,
          limit: Number(limit || env.HUBSPOT_POLL_LIMIT || 100),
          ...(after ? { after } : {})
        })
      });
      return {
        contacts: (payload.results || []).map((contact) => ({
          id: contact.id,
          properties: contact.properties || {},
          updatedAt:
            contact.properties?.lastmodifieddate ||
            contact.properties?.hs_lastmodifieddate ||
            contact.updatedAt
        })),
        nextAfter: payload.paging?.next?.after || null,
        hasMore: Boolean(payload.paging?.next?.after)
      };
    }
  };
}
