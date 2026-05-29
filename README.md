# Wix HubSpot Integration

Self-hosted full-stack Wix app submission for bidirectional Wix Contacts and HubSpot CRM contact sync, plus Wix form lead capture with attribution.

The app still supports mock mode for local review, but real mode now includes HubSpot OAuth, server-side token refresh, real HubSpot CRM API calls, real Wix Contacts API calls, signed webhooks, and SQLite persistence.

## Submission

Repository:

```text
https://github.com/karasdev/wix-hubspot-integration
```

Reviewer access:

```text
Mock mode requires no Wix or HubSpot credentials.
Default local demo key: dev-webhook-secret
Run: npm run dev
Open: http://localhost:3000
Webhook API key field: dev-webhook-secret
```

Production reviewer credentials are intentionally not committed. To review real mode, use the Wix signed instance token and HubSpot OAuth app credentials provided out of band by the app owner.

See `REVIEWER.md` for the deployed-review checklist, Wix app settings, HubSpot app settings, and step-by-step acceptance test script.

## What Is Implemented

- HubSpot OAuth connect/callback/disconnect with CSRF `state` bound to a Wix site/installation.
- Production token storage: Wix Secret Manager handoff when provided, or AES-256-GCM encrypted self-hosted storage with `TOKEN_ENCRYPTION_KEY`.
- HubSpot token refresh before expiry and retry on `401`.
- Real HubSpot Contacts API create/update/upsert and search-by-email.
- Real HubSpot Properties API catalog for dashboard mapping dropdowns.
- Real Wix Contacts API create/update and email lookup.
- Signed inbound Wix contact and form webhooks.
- Signed inbound HubSpot contact webhook endpoint.
- Signed Wix instance/app token authorization for real-mode dashboard/API requests, bound to `siteId` and `installId`.
- Site-scoped storage isolation for Wix installations, HubSpot connections, field mappings, contact mappings, sync events, retry jobs, and polling checkpoints.
- SQLite schema migration/versioning for the site-scoped storage tables and indexes.
- Real Wix install endpoint that verifies a signed Wix instance/app token, creates a Wix OAuth access token with app credentials, stores it encrypted, and refreshes it before expiry.
- HubSpot webhook registration status after OAuth connect, with a documented polling fallback when app-level webhook APIs are unavailable.
- HubSpot contact webhook hydration: property-change webhooks fetch the full HubSpot contact before mapping to Wix.
- Executable HubSpot polling fallback with persisted checkpoint state.
- Persisted retry jobs with exponential backoff for transient `429` and `5xx` sync failures.
- SQLite storage for installations, HubSpot connections, mappings, contact mappings, processed events, sync events, form submissions, OAuth states, polling checkpoints, retry jobs, and mock records.
- Last-updated-wins conflict handling.
- Persisted processed sync IDs/event IDs for replay protection.
- Origin echo suppression and identical HubSpot write diffing.
- Wix form submission lead capture with UTM/source context.
- Dashboard connect/disconnect, field mapping table, catalog loading, redacted sync activity, and no token exposure.
- Protected reviewer evidence endpoint summarizing live acceptance checklist status without exposing tokens.

## Run Locally

Requirements:

```text
Node.js 24+
npm 10+
```

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

Run tests:

```bash
npm test
```

The app uses built-in Node APIs only. No package install is required.

For a clean local demo, delete `data/app-db.sqlite`. The file is generated automatically and ignored by Git.

## Quick Mock Demo

```text
1. Open http://localhost:3000
2. Enter dev-webhook-secret in the Webhook API key field
3. Click Connect HubSpot
4. Click Sync Wix to HubSpot twice to see create/update behavior
5. Click Sync HubSpot to Wix twice to see reverse sync
6. Click Capture Lead
7. Review Sync Activity and Demo Records
```

## Environment Variables

```text
PORT=3000
APP_BASE_URL=http://localhost:3000
STORE_MODE=sqlite
DB_PATH=data/app-db.sqlite

WEBHOOK_API_KEY=dev-webhook-secret
TOKEN_ENCRYPTION_KEY=

HUBSPOT_MODE=mock
WIX_MODE=mock

HUBSPOT_CLIENT_ID=
HUBSPOT_CLIENT_SECRET=
HUBSPOT_REDIRECT_URI=http://localhost:3000/api/auth/hubspot/callback
HUBSPOT_API_BASE_URL=https://api.hubapi.com
HUBSPOT_OAUTH_BASE_URL=https://api.hubapi.com
HUBSPOT_APP_ID=
HUBSPOT_DEVELOPER_API_KEY=
HUBSPOT_POLL_LIMIT=100
HUBSPOT_POLL_MAX_PAGES=10
HUBSPOT_POLL_INITIAL_LOOKBACK_MINUTES=1440
HUBSPOT_POLL_PROPERTIES=email,firstname,lastname,phone,company,lastmodifieddate,hs_lastmodifieddate

WIX_ACCESS_TOKEN=
WIX_SITE_ID=
WIX_INSTANCE_ID=
WIX_API_BASE_URL=https://www.wixapis.com
WIX_OAUTH_BASE_URL=https://www.wixapis.com
WIX_APP_ID=
WIX_APP_SECRET=
WIX_INSTALL_TOKEN_EXCHANGE_URL=
WIX_INSTALL_TOKEN_EXCHANGE_API_KEY=
WIX_WEBHOOK_SECRET=
WIX_INSTANCE_SECRET=
WIX_SECRET_MANAGER_TOKEN_JSON=
WIX_SECRET_MANAGER_TOKEN_NAME=hubspot-oauth-tokens
WIX_SECRET_MANAGER_WIX_TOKEN_NAME=wix-site-access-token
WIX_SECRET_MANAGER_WIX_REFRESH_TOKEN_NAME=wix-refresh-token
```

Use `HUBSPOT_MODE=real` to enable real HubSpot OAuth/API calls. Use `WIX_MODE=real` to enable real Wix Contacts API calls. Keep `WEBHOOK_API_KEY` for mock/local review only; in real mode dashboard/API requests should include a signed Wix instance/app token in `Authorization: Bearer ...`, `x-wix-instance-token`, or `x-wix-app-token`.

Generate `TOKEN_ENCRYPTION_KEY` for self-hosted mode:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

## HubSpot App Setup

Create a HubSpot public app and configure:

```text
Redirect URL: ${APP_BASE_URL}/api/auth/hubspot/callback
Scopes:
- crm.objects.contacts.read
- crm.objects.contacts.write
- crm.schemas.contacts.read
```

Set:

```text
HUBSPOT_CLIENT_ID
HUBSPOT_CLIENT_SECRET
HUBSPOT_REDIRECT_URI
HUBSPOT_MODE=real
```

The callback exchanges the authorization code server-side and stores the access token, refresh token, expiry, and portal ID in SQLite. `/api/state` removes token fields before returning connection status to the browser.

Disconnect calls HubSpot refresh-token revocation when a refresh token exists, then clears stored credentials.

After OAuth connect the server records HubSpot webhook registration state in `/api/state.webhookRegistrations`. If `HUBSPOT_APP_ID` and `HUBSPOT_DEVELOPER_API_KEY` are configured, the server attempts contact create/property-change subscription registration. If those app-level credentials are not available, status is set to `polling-fallback`.

Run polling fallback manually or from a scheduler:

```text
POST ${APP_BASE_URL}/api/poll/hubspot
Authorization: Bearer <signed Wix instance/app token>
```

Optional body:

```json
{
  "since": "2026-05-28T10:00:00.000Z",
  "limit": 100,
  "maxPages": 10,
  "properties": ["email", "firstname", "lastname", "phone", "company", "lastmodifieddate"]
}
```

The checkpoint is persisted in `/api/state.pollingCheckpoints` with `lastSeenModifiedAt`, `nextAfter`, `lastSuccessfulPollAt`, status, and last error. If no checkpoint exists, polling starts from `HUBSPOT_POLL_INITIAL_LOOKBACK_MINUTES` ago. Polling follows HubSpot paging cursors up to `HUBSPOT_POLL_MAX_PAGES`; failed or incomplete polls do not advance the last-seen checkpoint.

Reviewer evidence endpoint:

```text
GET ${APP_BASE_URL}/api/reviewer/evidence
Authorization: Bearer <signed Wix instance/app token>
```

The response reports whether HubSpot OAuth, Wix install, Wix-to-HubSpot sync, HubSpot-to-Wix sync or polling, form attribution capture, automated cross-site isolation coverage, and token redaction checks have passed for the current site.

## Wix App And Webhook Setup

For a real self-hosted Wix installation:

```text
WIX_MODE=real
HUBSPOT_MODE=real
WIX_APP_ID
WIX_APP_SECRET
WIX_INSTANCE_SECRET optional if different from WIX_APP_SECRET
TOKEN_ENCRYPTION_KEY
```

Install/authenticate the Wix side with:

```text
POST ${APP_BASE_URL}/api/auth/wix/install
Authorization: Bearer <signed Wix instance/app token>
```

Token exchange options:

- Preferred production path: set `WIX_APP_ID` and `WIX_APP_SECRET`. `/api/auth/wix/install` verifies the signed Wix token, uses the verified `installId` as the Wix app `instance_id`, calls `POST https://www.wixapis.com/oauth2/token` with `grant_type=client_credentials`, and stores the returned access token with its expiry.
- Optional production hook: set `WIX_INSTALL_TOKEN_EXCHANGE_URL` only if your organization centralizes Wix token creation in a separate service. The app posts `{ instanceToken, siteId, installId }` to that internal exchange endpoint and expects `{ accessToken, expiresAt?, tokenType? }`.
- Simple self-hosted/reviewer path: set `WIX_ACCESS_TOKEN`. `/api/auth/wix/install` verifies the signed Wix token, then stores that site access token against the verified site/installation.

The stored Wix access token is never returned to the browser and is encrypted at rest when `TOKEN_ENCRYPTION_KEY` is set. If `WIX_SECRET_MANAGER_TOKEN_JSON` is provided, storage records a Wix Secret Manager handoff instead of serializing token material directly. The real Wix adapter refreshes/recreates the token before expiry using the stored app instance ID.

Self-hosted Wix app settings:

```text
App URL:       ${APP_BASE_URL}
Dashboard URL: ${APP_BASE_URL}
OAuth app ID:  WIX_APP_ID
OAuth secret:  WIX_APP_SECRET
Webhook URLs:
- ${APP_BASE_URL}/api/webhooks/wix-contact
- ${APP_BASE_URL}/api/webhooks/wix-form
Install call:
- POST ${APP_BASE_URL}/api/auth/wix/install with a signed Wix instance/app token
```

The template in `docs/wix-self-hosted-app.json` lists the URLs and permissions to copy into the Wix app dashboard.

Configure Wix event delivery to:

```text
POST ${APP_BASE_URL}/api/webhooks/wix-contact
POST ${APP_BASE_URL}/api/webhooks/wix-form
```

The server verifies the HMAC signature using `WIX_WEBHOOK_SECRET` before processing. Unsigned webhook requests are rejected.

Real-mode dashboard and API requests are bound to the Wix site/installation. The server verifies signed Wix instance/app tokens with `WIX_APP_SECRET` or `WIX_INSTANCE_SECRET`, extracts `siteId`/`installId`, and rejects cross-site requests after installation is connected.

Required Wix permissions/scopes:

```text
- Contacts read
- Contacts write
- Forms/submissions read or webhook event access
- App instance/site identity token access
```

## HubSpot Webhook Setup

Configure HubSpot contact change webhooks to:

```text
POST ${APP_BASE_URL}/api/webhooks/hubspot-contact
```

The server validates HubSpot signatures using `HUBSPOT_CLIENT_SECRET`. Accepted events are normalized and routed into the HubSpot-to-Wix sync path.

Webhook URLs for deployment:

```text
Wix contact:  POST ${APP_BASE_URL}/api/webhooks/wix-contact
Wix form:     POST ${APP_BASE_URL}/api/webhooks/wix-form
HubSpot:      POST ${APP_BASE_URL}/api/webhooks/hubspot-contact
Retry runner: POST ${APP_BASE_URL}/api/retry/due
Poll runner:  POST ${APP_BASE_URL}/api/poll/hubspot
```

## API Plan

Feature 1, bidirectional contact sync:

- Wix Contacts API: create, update, query contacts by email.
- Wix contact webhooks: contact created/updated events into `/api/webhooks/wix-contact`.
- HubSpot CRM Contacts API: create/update contacts, read by contact ID, search by email.
- HubSpot Properties API: load contact property catalog for the mapping table.
- HubSpot contact webhooks: inbound contact updates into `/api/webhooks/hubspot-contact`.
- HubSpot polling fallback: scheduled `/api/poll/hubspot` searches contacts whose `lastmodifieddate` is newer than the persisted checkpoint.

Feature 2, form and lead capture:

- Wix form submission webhooks into `/api/webhooks/wix-form`.
- HubSpot CRM Contacts API create/update with mapped form fields and attribution fields.
- Stored form metadata for observability: form ID, page URL, referrer, timestamp, and UTM fields.

Install/auth APIs:

- Wix installation: `/api/auth/wix/install` verifies a Wix signed token and stores/exchanges the Wix site access token.
- HubSpot OAuth: `/api/auth/hubspot/connect`, `/api/auth/hubspot/callback`, `/api/auth/hubspot/disconnect`.

## Acceptance Test Steps

Mock/local:

```text
1. npm run dev
2. Open http://localhost:3000
3. Enter dev-webhook-secret in the Webhook API key field
4. Click Connect HubSpot
5. Save a mapping row
6. Submit Wix Contact Event and verify a HubSpot mock record/count appears
7. Submit HubSpot Contact Event and verify a Wix mock record/count appears
8. Submit Wix Form Lead Capture and verify attribution fields in Sync Activity
9. Run npm test
```

Production/self-hosted:

```text
1. Set HUBSPOT_MODE=real, WIX_MODE=real, APP_BASE_URL, TOKEN_ENCRYPTION_KEY, HubSpot OAuth vars, and Wix signing secret.
2. Set WIX_INSTALL_TOKEN_EXCHANGE_URL or WIX_ACCESS_TOKEN.
3. POST /api/auth/wix/install with a signed Wix instance/app token.
4. Open the dashboard with that token available, then click Connect HubSpot and complete OAuth.
5. Confirm /api/state shows connected=true, no token fields, tokenStorage=encrypted or wix-secret-manager.
6. Send signed Wix contact/form webhooks and signed HubSpot contact webhooks.
7. If HubSpot webhooks are unavailable, POST /api/poll/hubspot and verify pollingCheckpoints advances.
8. POST /api/retry/due after forcing a transient provider error and verify retry state resolves.
```

## HubSpot Attribution Properties

The default mapping writes Wix attribution into these HubSpot contact properties:

```text
utm_source   -> wix_utm_source
utm_medium   -> wix_utm_medium
utm_campaign -> wix_utm_campaign
utm_term     -> wix_utm_term
utm_content  -> wix_utm_content
pageUrl      -> wix_page_url
referrer     -> wix_referrer
```

Create those custom HubSpot contact properties in the HubSpot portal, or change the mapping table to use existing properties.

## Sync Correctness

The sync service stores:

- `wixContactId <-> hubspotContactId`
- `syncId` / event ID history
- processed event IDs
- source timestamps
- last Wix and HubSpot update timestamps
- origin metadata
- outbound origin/correlation metadata:
  - `wix_hubspot_origin = wix-hubspot-integration`
  - `wix_hubspot_sync_id = syncId`
  - `wix_hubspot_synced_at = timestamp`

Rules:

- Latest updated timestamp wins.
- Duplicate `syncId` or event ID is skipped.
- Webhook echoes with origin `wix-hubspot-integration` are skipped.
- HubSpot and Wix writes skip when identical mapped values are already known.
- SQLite writes happen in a transaction.

## Retry And Failure Handling

Transient HubSpot/Wix `429` and `5xx` errors create persisted retry jobs with exponential backoff. Permanent validation/auth errors are marked failed instead of retried forever. Retry/failure state appears in `/api/state.retryJobs` with contact payloads redacted, and sync activity shows `retry_pending` or `failed`.

## Security

- OAuth tokens are never returned from browser APIs.
- Tokens are not logged.
- HubSpot OAuth tokens and stored Wix access tokens are encrypted at rest when `TOKEN_ENCRYPTION_KEY` is set. The stored SQLite/JSON value contains AES-GCM ciphertext, not raw access or refresh tokens.
- If running inside Wix backend code, prefer Wix Secret Manager for token material; this self-hosted app can record a Secret Manager handoff with `WIX_SECRET_MANAGER_TOKEN_JSON`/`WIX_SECRET_MANAGER_TOKEN_NAME`, while normal self-hosted deployment should use `TOKEN_ENCRYPTION_KEY`.
- `/api/state` redacts PII in sync activity and form submissions.
- Mock/local dashboard mutating routes require `x-webhook-api-key` or bearer token. Real-mode dashboard/API routes require a signed Wix instance/app token and reject cross-site access.
- Wix and HubSpot webhook endpoints require provider signatures.
- HubSpot scopes are limited to contacts read/write and contact property read.
- Polling fallback uses the same HubSpot contact read scope and only advances checkpoints after a successful run.

## Tests

```bash
npm test
```

Covered behaviors include:

- Protected route rejection.
- Mapping validation.
- OAuth state/code exchange.
- No token exposure in API responses.
- Encrypted token persistence.
- Encrypted Wix install token persistence.
- Wix OAuth client-credentials token creation and refresh before Wix API calls.
- HubSpot multi-page polling fallback and checkpoint failure safety.
- HubSpot webhook updates Wix.
- Wix contact webhook updates HubSpot.
- Echo webhook suppression from outbound origin metadata.
- Duplicate HubSpot property mapping rejection.
- Transient sync failure retry job creation.
- Token refresh.
- HubSpot contact create through mocked HTTP.
- Wix contact create through mocked HTTP.
- Signed Wix form webhook lead capture.
- Duplicate event replay.
- Conflict handling.
- Webhook echo suppression.
- Existing mock dashboard flows.

## Production Limitations

- SQLite is suitable for local/dev and small deployments. For multi-instance production, replace `src/storage/sqliteStore.js` with a Postgres implementation using the same store contract.
- HubSpot webhook auto-registration depends on app-level HubSpot webhook credentials. Without those, the app records `polling-fallback` and the deployer should run a scheduler against `/api/poll/hubspot`.
- HubSpot polling follows paging cursors up to `HUBSPOT_POLL_MAX_PAGES` per run. For very large portals, raise that value or schedule polling more frequently.
- The Wix Secret Manager path is documented as the preferred Wix-hosted approach; the self-hosted default is encrypted SQLite/JSON using `TOKEN_ENCRYPTION_KEY`.
- HubSpot webhook payloads can be property-level; if your HubSpot app sends only object IDs, add a contact fetch before calling the sync service.
- Wix field catalogs are static because Wix contact custom field metadata differs by app/site setup; mapped extended fields are still sent through the Wix Contacts payload.
