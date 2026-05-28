# Wix HubSpot Integration

Self-hosted full-stack prototype for a Wix App Market style integration that syncs Wix contacts and form leads with HubSpot CRM.

The demo intentionally avoids Wix Editor setup. It exposes webhook-style endpoints for Wix events and includes dashboard controls that simulate Wix contact updates and form submissions locally.

## Features

- HubSpot connect/disconnect flow with mock mode and production OAuth placeholders
- Field mapping dashboard with persistence and duplicate HubSpot property validation
- Wix contact to HubSpot contact sync
- HubSpot contact to Wix contact sync
- Wix form submission lead capture with UTM/source context
- Default attribution mappings for `utm_source`, `utm_campaign`, `pageUrl`, and `referrer`
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
- Conflict strategy: latest updated timestamp wins; if timestamps are unavailable, prefer deterministic source priority configured per mapping

### Feature 2: Form and Lead Capture

Chosen approach:

- Use Wix forms as the UI and send submissions to this app through webhook-style endpoints.

Wix side:

- Wix Forms submission events/webhooks
- Submission payload includes contact fields, page URL, referrer, timestamp, and UTM parameters

HubSpot side:

- HubSpot CRM Contacts API to create/update the contact
- Optional HubSpot custom properties for attribution fields such as `utm_source`, `utm_medium`, `utm_campaign`, `page_url`, and `referrer`

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

## Demo Flow

1. Click `Connect HubSpot` to connect in mock mode.
2. Review or edit field mappings.
3. Click `Sync Wix to HubSpot` to simulate a Wix contact event.
4. Click `Sync HubSpot to Wix` to simulate a HubSpot webhook event.
5. Click `Capture Lead` to simulate a Wix form submission with attribution.
6. Review sync events and record counts in the dashboard.
