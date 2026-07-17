# Trace Portal

The web interface for investigating errors, logs, players, sessions, and Roblox server jobs captured by Trace.

## Local development

Development requests are proxied to the deployed Trace API configured by `TRACE_API_URL` in `.env.development`. The Vite proxy reads the local-only `TRACE_DEV_READ_TOKEN` from:

```text
../Trace/api/.env
```

The token is attached by the development server and is never included in the browser bundle.

```bash
npm install
npm run dev
```

Open `http://localhost:5173`.

Optional server-side development overrides:

```text
TRACE_API_URL=https://trace-production-c9d4.up.railway.app
TRACE_DEV_READ_TOKEN=...
```

## Production API configuration

Production builds read `VITE_TRACE_API_BASE_URL=https://api.tracestack.gg`
from `.env.production` and call the deployed API directly. Requests include
credentials and must authenticate with the `trace_session` HttpOnly cookie.

Railway's `WEB_ORIGIN` must be exactly `https://tracestack.gg`, and
`ROBLOX_OAUTH_REDIRECT_URI` must be exactly
`https://api.tracestack.gg/v1/auth/roblox/callback`. Never expose ingestion
credentials or a read-session token through a `VITE_` environment variable.

## Railway deployment

The portal deploys as a separate Railway service from the same repository as
the API. Configure the service with:

```text
Root directory: /portal
Builder: Dockerfile (detected automatically)
Config file path: /portal/railway.json
Health check: /health
Custom domain: tracestack.gg
```

The production container builds the Vite app and serves `dist` with Caddy on
Railway's assigned `PORT`. The public API origin is committed in
`.env.production`; no frontend secret is required.

## Validation

```bash
npm run lint
npm run build
```

The implemented API contract is documented in `READ_API_IMPLEMENTATION_HANDOFF.md`.
