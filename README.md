# Wix HubSpot Integration

Self-hosted full-stack prototype for a Wix App Market style integration that syncs Wix contacts and form leads with HubSpot CRM.

The demo intentionally avoids Wix Editor setup. It exposes webhook-style endpoints for Wix events and includes dashboard controls that simulate Wix contact updates and form submissions locally.

## Architecture

```text
Wix contact/form event
        |
        v
Protected webhook endpoint
        |
        v
Sync service + field mapper
        |
        v
Wix adapter / HubSpot adapter
        |
        v
JSON demo store (replace with database in production)
```

The HTTP server is intentionally thin. Business behavior lives in:

```text
src/services/syncService.js
src/services/fieldMapper.js
src/adapters/mockWixAdapter.js
src/adapters/mockHubSpotAdapter.js
src/storage/jsonStore.js
```

## Features

- HubSpot connect/disconnect flow with mock mode and production OAuth placeholders
- Field mapping dashboard with persistence and duplicate HubSpot property validation
- Wix contact to HubSpot contact sync
- HubSpot contact to Wix contact sync
- Wix form submission lead capture with UTM/source context
- Default attribution mappings for `utm_source`, `utm_campaign`, `pageUrl`, and `referrer`
- Expanded contact/attribution mappings including company, UTM medium, UTM term, and UTM content
- Timestamp conflict handling using a latest-updated-wins rule
- Contact ID mapping: `wixContactId <-> hubspotContactId`
- Loop prevention using `syncId`, source tracking, and idempotent updates
- API key protection for webhook-style sync endpoints
- Sync activity log for observability

## Run Locally

```bash
npm install
npm run dev
```

Open:

```text
http://localhost:3000
```

This project currently uses only built-in Node.js modules, so it can also run without installing packages:

```bash
npm run dev
```

Optional local environment:

```bash
cp .env.example .env
```

Environment variables:

```text
PORT=3000
APP_BASE_URL=http://localhost:3000
HUBSPOT_CLIENT_ID=
HUBSPOT_CLIENT_SECRET=
HUBSPOT_REDIRECT_URI=http://localhost:3000/api/auth/hubspot/callback
HUBSPOT_MODE=mock
WEBHOOK_API_KEY=dev-webhook-secret
```

## Mock vs Production Mode

The submitted demo runs in mock mode by default so it can be reviewed without Wix or HubSpot developer credentials.

Mock mode:

- Stores demo data in `data/app-db.json`
- Simulates HubSpot contact create/update behavior
- Simulates Wix contact create/update behavior
- Keeps OAuth tokens out of the browser by design

Production mode:

- Exchange HubSpot OAuth `code` for access and refresh tokens on the server
- Store encrypted tokens in a database or secret manager
- Replace mock adapters with real Wix and HubSpot API clients
- Validate Wix and HubSpot webhook signatures
- Use a durable queue for retries and rate-limit handling

## API Plan

### Feature 1: Reliable Bidirectional Contact Sync

Wix side:

- Wix Contacts API for creating/updating Wix contacts
- Wix contact events/webhooks for contact created and contact updated events

HubSpot side:

- HubSpot CRM Contacts API for create/update/upsert behavior
- HubSpot Properties API to list available contact properties for mapping
- HubSpot Webhooks API for inbound HubSpot contact changes

Sync data model:

- Store external ID mapping: `wixContactId <-> hubspotContactId`
- Store `syncId`, `source`, and timestamps for each sync event
- Ignore duplicate events with the same correlation ID
- Avoid rewriting identical values
- Conflict strategy: latest updated timestamp wins. Wix events older than the last accepted HubSpot update are skipped, and HubSpot events older than the last accepted Wix update are skipped.

### Feature 2: Form and Lead Capture

Chosen approach:

- Use Wix forms as the UI and send submissions to this app through webhook-style endpoints.

Wix side:

- Wix Forms submission events/webhooks
- Submission payload includes contact fields, page URL, referrer, timestamp, and UTM parameters

HubSpot side:

- HubSpot CRM Contacts API to create/update the contact
- Optional HubSpot custom properties for attribution fields such as `utm_source`, `utm_medium`, `utm_campaign`, `page_url`, and `referrer`

## Sample Payloads

### Wix Contact Event

```json
{
  "wixContactId": "wix_123",
  "syncId": "corr_wix_123_001",
  "updatedAt": "2026-05-28T17:30:00.000Z",
  "fields": {
    "email": "maria@example.com",
    "firstName": "Maria",
    "lastName": "Santos",
    "phone": "+1 555 0100",
    "company": "Santos Events"
  }
}
```

### HubSpot Contact Event

```json
{
  "hubspotContactId": "hs_123",
  "syncId": "corr_hs_123_001",
  "updatedAt": "2026-05-28T17:45:00.000Z",
  "properties": {
    "email": "maria@example.com",
    "firstname": "Maria",
    "lastname": "Santos",
    "phone": "+1 555 0100",
    "company": "Santos Events"
  }
}
```

### Wix Form Submission

```json
{
  "formId": "contact-us",
  "pageUrl": "https://demo-wix-site.example/contact",
  "referrer": "https://google.com",
  "utm_source": "google",
  "utm_medium": "cpc",
  "utm_campaign": "spring_launch",
  "fields": {
    "email": "lead@example.com",
    "firstName": "Jordan",
    "lastName": "Lee",
    "phone": "+1 555 0199"
  }
}
```

## Security Notes

- HubSpot OAuth tokens must stay server-side only.
- The browser never receives access tokens or refresh tokens.
- Production token storage should use a secret manager or encrypted database column.
- Logs should never include raw tokens or unnecessary PII.
- Webhook endpoints should validate signatures and require tenant/site authorization.
- Demo webhook endpoints require `x-webhook-api-key` or `Authorization: Bearer <key>`.
- Set `WEBHOOK_API_KEY` in the environment before deploying.
- OAuth scopes should be limited to contacts/properties access needed by this integration.

## Important Endpoints

```text
GET  /api/state
POST /api/auth/hubspot/connect
GET  /api/auth/hubspot/callback
POST /api/auth/hubspot/disconnect
POST /api/mappings
POST /api/sync/wix-contact
POST /api/sync/hubspot-contact
POST /api/forms/wix-submission
```

Protected routes:

```text
POST /api/sync/wix-contact
POST /api/sync/hubspot-contact
POST /api/forms/wix-submission
```

For local API testing, include:

```text
x-webhook-api-key: dev-webhook-secret
```

## API Test Examples

Wix contact sync:

```bash
curl -X POST http://localhost:3000/api/sync/wix-contact \
  -H "content-type: application/json" \
  -H "x-webhook-api-key: dev-webhook-secret" \
  -d '{
    "wixContactId": "wix_demo_1",
    "updatedAt": "2026-05-28T17:30:00.000Z",
    "fields": {
      "email": "maria@example.com",
      "firstName": "Maria",
      "lastName": "Santos",
      "company": "Santos Events"
    }
  }'
```

HubSpot contact sync:

```bash
curl -X POST http://localhost:3000/api/sync/hubspot-contact \
  -H "content-type: application/json" \
  -H "x-webhook-api-key: dev-webhook-secret" \
  -d '{
    "hubspotContactId": "hs_demo_1",
    "updatedAt": "2026-05-28T17:45:00.000Z",
    "properties": {
      "email": "maria@example.com",
      "firstname": "Maria",
      "lastname": "Santos",
      "company": "Santos Events"
    }
  }'
```

Form submission capture:

```bash
curl -X POST http://localhost:3000/api/forms/wix-submission \
  -H "content-type: application/json" \
  -H "x-webhook-api-key: dev-webhook-secret" \
  -d '{
    "formId": "contact-us",
    "pageUrl": "https://demo-wix-site.example/contact",
    "referrer": "https://google.com",
    "utm_source": "google",
    "utm_medium": "cpc",
    "utm_campaign": "spring_launch",
    "fields": {
      "email": "lead@example.com",
      "firstName": "Jordan"
    }
  }'
```

## Production Setup Notes

To connect real services:

1. Create a HubSpot developer app.
2. Add the callback URL:

```text
http://localhost:3000/api/auth/hubspot/callback
```

3. Set environment variables from `.env.example`.
4. Change `HUBSPOT_MODE=real`.
5. Register Wix contact/form event webhooks to the endpoints in this app.
6. Replace mock adapters with real Wix and HubSpot API clients.

Production persistence should replace `data/app-db.json` with database tables for:

- tenant/site installation
- HubSpot connection and encrypted tokens
- field mappings
- contact ID mappings
- sync events and retry state
- form submission metadata

## Current Limitations

- Real Wix webhook registration is documented but not connected in this local demo.
- Real HubSpot token exchange is represented as a server-side route placeholder.
- JSON storage is for local review only and should be replaced before deployment.
- Webhook API key protection should be upgraded to provider signature validation in production.

## Demo Flow

1. Click `Connect HubSpot` to connect in mock mode.
2. Review or edit field mappings.
3. Click `Sync Wix to HubSpot` to simulate a Wix contact event.
4. Click `Sync HubSpot to Wix` to simulate a HubSpot webhook event.
5. Click `Capture Lead` to simulate a Wix form submission with attribution.
6. Review sync events and record counts in the dashboard.
