# Production domain rollout

Trace uses two public origins:

```text
Portal: https://tracestack.gg
API:    https://api.tracestack.gg
```

Keeping the portal and API under the same registrable domain allows the API's
secure `SameSite=Lax` session cookie to work without weakening it to
`SameSite=None`.

## Railway API

Add `api.tracestack.gg` as a custom domain on the production API service in
Railway. Railway will generate a service-specific CNAME target and a TXT domain
verification record. Both records are required.

Set these production variables on the API service:

```text
HOST=0.0.0.0
WEB_ORIGIN=https://tracestack.gg
ROBLOX_OAUTH_REDIRECT_URI=https://api.tracestack.gg/v1/auth/roblox/callback
```

Keep `DATABASE_URL`, `ROBLOX_OAUTH_CLIENT_ID`, and
`ROBLOX_OAUTH_CLIENT_SECRET` as secrets. Railway supplies `PORT`.

## Railway portal

Deploy `portal/` as a second service in the same Railway project. Connect it to
the same GitHub repository, set its root directory to `/portal`, and set its
config file path to `/portal/railway.json`. Railway detects
`portal/Dockerfile`; the config file enables the `/health` check.

Add `tracestack.gg` as the portal service's custom domain. Do not attach the
apex domain to the API service.

## Cloudflare DNS

After Railway creates the API custom domain, add the exact records it shows:

| Type | Name | Target/value | Proxy | TTL |
| --- | --- | --- | --- | --- |
| CNAME | `api` | Railway-generated `*.up.railway.app` target | Proxied | Auto |
| TXT | Railway-provided name | Railway-provided verification value | DNS only | Auto |

The portal service separately generates the records for the apex domain. Add
`tracestack.gg` as a custom domain on the Railway portal service and use the
CNAME and TXT values generated for that service. In Cloudflare, an apex CNAME
uses name `@`; Cloudflare flattens it automatically.

Add `www` only as a redirect alias:

```text
CNAME  www  @  Proxied  Auto
```

Then create a Cloudflare redirect from `https://www.tracestack.gg/*` to
`https://tracestack.gg/$1` with the path and query string preserved.

For Cloudflare-proxied Railway records, set Cloudflare SSL/TLS encryption mode
to **Full**. Do not create fixed A/AAAA records for Railway and do not point
`api` at the old `trace-production-c9d4.up.railway.app` hostname unless that is
the target Railway explicitly generates for the custom domain.

## Roblox OAuth

In the Roblox OAuth app, add this exact production redirect URL:

```text
https://api.tracestack.gg/v1/auth/roblox/callback
```

Keep the localhost callback while local development still uses it. The OAuth
app's entry link should be `https://tracestack.gg`.

## Roblox experience secrets

For every connected experience, edit or recreate the `TraceKey` secret so its
allowed domain is exactly:

```text
api.tracestack.gg
```

Do not use `*`. Keep **Allow HTTP Requests** enabled. Existing published games
must also receive the SDK build whose endpoint is `https://api.tracestack.gg`;
changing DNS does not rewrite code already published in Roblox.

Build the downloadable SDK only from `distribution.project.json`. It explicitly
excludes `LocalConfig.luau` and test scripts from the public model.

## Cutover verification

Perform these checks only after both custom domains have valid TLS and Railway
shows them as verified:

```text
GET https://api.tracestack.gg/health
```

Then verify a complete Roblox sign-in, logout, portal API request, and a fresh
live Roblox server telemetry upload before retiring the Railway URL from any
remaining operational notes.
