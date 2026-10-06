# Nexus Locator

Nexus Locator is a consent-based location-sharing web app. A location is collected only from a signed-in device after its owner chooses to share and grants the browser's location permission. A phone number or email address cannot independently reveal someone's GPS location.

## Run in Replit

1. Ensure the Replit-managed PostgreSQL database and the `SESSION_SECRET` secret are available. Use a long, randomly generated secret; never commit it.
2. Install dependencies with `npm install`.
3. Apply the development schema with `npm run db:push`.
4. Start the **Start application** workflow, or run `npm run dev`. The app listens on port 5000.
5. Open the app over HTTPS. Browser location APIs require a secure context (localhost is also supported for local development).

The app creates no demo users and never fabricates coordinates. Create an account, register the current browser, then explicitly enable sharing. For another person to share their device, create an invitation and send the one-time link to them yourself. They must sign in, open the link on the device they want to share, approve sharing, and grant browser location permission. Email and SMS delivery/verification are not configured; no invitation is sent automatically.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Yes (provided by Replit PostgreSQL) | PostgreSQL connection |
| `SESSION_SECRET` | Yes | Signs secure session cookies; keep it in Replit Secrets |
| `LOCATION_RETENTION_HOURS` | No (default `24`) | Automatic maximum retention for precise location points (1–720 hours) |
| `NODE_ENV` | No | Set to `production` for production cookie and asset behavior |

The server rejects startup when the database or session secret is missing. Precise location payloads are encrypted with AES-256-GCM before they are written to PostgreSQL; the encryption key is derived with a separate HKDF context from `SESSION_SECRET`. Rotating that secret also makes unexpired location points unreadable, so wait until the configured retention window has elapsed before rotating it. Location retention is enforced by point expiry and a periodic cleanup job. Sharing metadata and audit events do not include precise coordinates.

## Database changes and publishing

`shared/schema.ts` is the database schema source. `npm run db:push` applies it to the **development** database only. Replit's Publish flow manages the production schema diff; review the schema changes in Publish before confirming.

## Administration

New accounts are regular users. To grant the first administrator, run `npm run admin:promote -- account@example.com` from the Replit shell after creating that account. This command promotes exactly the named existing account in the development database; do not promote an address you do not control. Promote a production administrator through an approved production database administration process, not this development command.

Administrators can review account/device metadata, aggregate usage, system status, abuse reports, and security audit events. Admin APIs intentionally do not return precise locations or location histories.

## Privacy and location

- Location sharing is opt-in for each device and is stopped by the device owner or the authorized viewer.
- Location updates use the browser Geolocation API; permissions are never bypassed.
- OpenStreetMap tiles are used for the map with attribution. No address lookup or geocoding is performed.
- Location points expire automatically according to `LOCATION_RETENTION_HOURS` (24 hours by default). Users can delete their account and its linked data.
- HTTPS is required in deployment for secure cookies and browser geolocation.

Review the in-app Terms and Privacy Policy before production use. This repository provides product controls, not legal advice or a substitute for an independent security/privacy review.
