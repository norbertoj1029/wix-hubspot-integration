# Reviewer Guide

## Submission Links

```text
GitHub repository: https://github.com/karasdev/wix-hubspot-integration
Deployed app URL: <provided by submitter>
Reviewer username: <provided by submitter>
Reviewer password: <provided out of band>
Wix test site: <provided by submitter>
HubSpot test portal: <provided by submitter>
```

Production credentials are not committed. The submitter should provide the deployed URL, a Wix signed instance/app token or Wix reviewer site access, and HubSpot OAuth test app credentials out of band.

## Local Review

```bash
npm run dev
```

Open `http://localhost:3000`, use mock mode, and enter `dev-webhook-secret` in the protected routes field.

## Production Environment Checklist

```text
APP_BASE_URL=<https deployed URL>
STORE_MODE=sqlite
TOKEN_ENCRYPTION_KEY=<32 byte hex key>
HUBSPOT_MODE=real
WIX_MODE=real
HUBSPOT_CLIENT_ID=<HubSpot public app client ID>
HUBSPOT_CLIENT_SECRET=<HubSpot public app client secret>
HUBSPOT_REDIRECT_URI=${APP_BASE_URL}/api/auth/hubspot/callback
WIX_APP_ID=<Wix app OAuth app ID>
WIX_APP_SECRET=<Wix app OAuth secret>
WIX_WEBHOOK_SECRET=<Wix webhook signing secret>
HUBSPOT_POLL_LIMIT=100
HUBSPOT_POLL_MAX_PAGES=10
```

## Wix App Settings

Use the template in `docs/wix-self-hosted-app.json`.

```text
App URL: ${APP_BASE_URL}
Dashboard URL: ${APP_BASE_URL}
Install endpoint: POST ${APP_BASE_URL}/api/auth/wix/install
Wix contact webhook: POST ${APP_BASE_URL}/api/webhooks/wix-contact
Wix form webhook: POST ${APP_BASE_URL}/api/webhooks/wix-form
```

Required Wix permissions:

```text
Contacts read
Contacts write
Forms/submissions webhook access
App instance/site identity
```

## HubSpot App Settings

```text
Redirect URL: ${APP_BASE_URL}/api/auth/hubspot/callback
Contact webhook URL: ${APP_BASE_URL}/api/webhooks/hubspot-contact
Scopes:
- crm.objects.contacts.read
- crm.objects.contacts.write
- crm.schemas.contacts.read
```

## Acceptance Test Script

1. Install/open the Wix app dashboard and call `POST /api/auth/wix/install` with a signed Wix instance/app token.
2. Click Connect HubSpot and complete OAuth in the HubSpot test portal.
3. Open the field mapping table, map `email`, `firstName`, `lastName`, `phone`, `company`, and attribution fields, then save.
4. Trigger a Wix contact create/update webhook and verify a HubSpot contact is created or updated.
5. Trigger a HubSpot contact webhook, or run `POST /api/poll/hubspot`, and verify the Wix contact is created or updated.
6. Repeat the same event ID or send an echo event with `wix_hubspot_origin=wix-hubspot-integration`; verify the sync is skipped and does not ping-pong.
7. Submit a Wix form webhook payload with UTM fields; verify HubSpot contact attribution properties are populated.
8. Run `POST /api/retry/due` after forcing a transient provider error; verify retry jobs are redacted and retried.
9. Call `POST /api/auth/hubspot/disconnect`; verify HubSpot tokens are revoked/cleared.
10. Call `POST /api/auth/wix/disconnect`; verify Wix credentials are cleared and never appear in `/api/state`.

## Production Evidence Checklist

Record these during deployed review:

```text
HubSpot OAuth completed:
Wix install completed:
Wix contact create/update reached HubSpot:
HubSpot webhook or polling update reached Wix:
Wix form attribution populated HubSpot fields:
Cross-site isolation checked with a second signed Wix site token:
/api/state token exposure check passed:
```

The same checklist is available from the deployed app:

```text
GET ${APP_BASE_URL}/api/reviewer/evidence
Authorization: Bearer <signed Wix instance/app token>
```

The automated suite includes regression coverage for per-site Wix state isolation and HubSpot property-change webhook hydration before syncing to Wix.

## Automated Tests

```bash
npm test
```

The suite covers OAuth, Wix install/auth lifecycle, encrypted token persistence, real-mode dashboard authorization, per-site isolation, SQLite legacy schema migration, hydrated HubSpot webhooks, reviewer evidence reporting, multi-page HubSpot polling, polling failure safety, loop prevention, form attribution, and provider adapter behavior.
