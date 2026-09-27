# Rox — Security & Bug Assessment

**Prepared for:** Head of Applied AI (stakeholder review)
**Environment:** Authorized test account (`Sharon Tester` / `Acme Test Corp`) on production hosts
**Scope:** Web app UI + backend APIs; non-destructive only (no outbound email/sequencing/CRM writeback/billing changes)
**Targets:** `https://run.rox.com` (Next.js/Vercel frontend), `https://core.be.rox.com` (gunicorn API), `https://fastapi.be.rox.com`
**Auth:** Auth0 RS256 JWT bearer (issuer `https://roxai.us.auth0.com/`, aud `https://api.roxhq.ai`)
**Date:** 2026-09-27

> All testing used a single authorized test tenant. No cross-tenant data was accessed. "Potential" findings are labeled where impact could not be fully confirmed without actions that were out of the non-destructive scope.

---

## Executive summary

Rox's core authentication and AI-agent defenses are **strong**: JWT validation rejects tampering/`alg:none`, direct prompt-injection was refused, mass-assignment was resisted, CORS uses a strict allow-list, a WAF blocks obvious script payloads, and no auth token is exposed to client JS. 

The most material issues are on the **data-access and abuse-control** side of the API:

| # | Finding | Severity | Confidence |
|---|---------|----------|------------|
| F1 | `data_extraction/companies` dumps the **entire 1.66M-row / 228 MB global company corpus** to any authenticated user; pagination ignored | **High** | Confirmed |
| F2 | Weak `domain` validation accepts internal/link-local IPs (`169.254.169.254`, `127.0.0.1`) → **potential SSRF** in enrichment | Medium | Partial |
| F3 | **No rate limiting / throttling** on read and compute endpoints (amplifies F1) | Medium | Confirmed |
| F4 | Prod API CORS allow-lists `http://localhost:3000` **with credentials** | Low–Med | Confirmed |
| F5 | Intermittent **raw `psycopg2` exception** leaked to client (DB engine + internal constraint name) | Low | Confirmed |
| F6 | Error messages leak caller's **internal user & org UUIDs** | Low | Confirmed |
| F7 | Inconsistent authz error semantics (`/deals` → 403 vs peers → 404) | Low | Confirmed |
| F8 | JS bundles disclose non-prod infra, S3 bucket names, config, mock-IdP URL | Info | Confirmed |
| F9 | CSP missing `frame-ancestors`; permissive `permissions-policy: geolocation=*` | Info | Confirmed |

---

## Findings (detail)

### F1 — Unbounded full-table export of the global company corpus  **[High]**
- **Endpoint:** `GET https://core.be.rox.com/api/v1/data_extraction/companies`
- **Repro:**
  ```bash
  curl -s "https://core.be.rox.com/api/v1/data_extraction/companies" \
    -H "Authorization: Bearer <token>" -o out.json
  # -> HTTP 200, out.json = 228,256,469 bytes, 1,656,866 company records
  curl -s ".../data_extraction/companies?page_size=1" ...   # -> still 228 MB (params ignored)
  ```
- **Observed:** A single authenticated request returns **1,656,866** company records (~228 MB) — Rox's proprietary global enrichment corpus (e.g. `Fyber`, `Tegus`, `Xiamen Airlines`), not tenant-scoped data. `page`, `page_size`, `limit` query params have no effect.
- **Impact:** (1) Wholesale exfiltration/scraping of a proprietary dataset by any low-privilege user. (2) DoS / cost / memory pressure — each call streams 228 MB from DB→app→client; a handful of concurrent calls (see F3) can exhaust resources.
- **Remediation:** Enforce mandatory server-side pagination with a hard max page size; require a search/filter query rather than allowing a full dump; add per-user quotas + response-size caps; audit who should reach this endpoint at all.

### F2 — Insufficient domain validation → potential SSRF  **[Medium, partial]**
- **Endpoint:** `POST https://core.be.rox.com/api/v1/data_extraction/companies`
- **Repro:**
  ```bash
  # accepted + stored (HTTP 201):
  {"data":{"name":"<unique>","domain":"169.254.169.254"}}   # AWS metadata IP
  {"data":{"name":"<unique>","domain":"127.0.0.1"}}         # loopback
  {"data":{"name":"<unique>","domain":"a'b.example"}}       # quote char
  # rejected (HTTP 404 "Company not valid"):
  {"data":{"name":"m","domain":"localhost:8080"}}
  {"data":{"name":"m","domain":"file:///etc/passwd"}}
  ```
- **Observed:** Link-local/loopback **IPs and quote characters pass validation and persist** as a company "domain"; only `host:port` and URL schemes are rejected. Whether the enrichment/crawl pipeline later fetches the stored domain was **not confirmed** (would require observing outbound fetch behavior).
- **Impact:** If any downstream job resolves/fetches the stored domain, an attacker can point Rox at `169.254.169.254` (cloud metadata / IAM creds) or internal services — classic SSRF. Even absent a fetch, the validator is too weak.
- **Remediation:** Validate domains against a strict hostname grammar; reject IP literals, private/link-local/loopback ranges, and non-DNS values; if enrichment fetches URLs, route through an egress allow-list/proxy that blocks RFC1918 + `169.254.0.0/16`.

### F3 — No rate limiting / throttling  **[Medium]**
- **Endpoints (examples):** `GET /api/v1/user_extra/me`, `POST /api/v1/insights_v2`
- **Repro:** 40 concurrent `GET /user_extra/me` → 40× HTTP 200; 30 concurrent `POST /insights_v2` → 30× HTTP 200. No `Retry-After` / `X-RateLimit-*` headers on any response.
- **Impact:** Enables brute-force/enumeration, scraping, and cost/DoS amplification — especially combined with F1's 228 MB responses and any LLM-backed compute endpoints.
- **Remediation:** Per-user + per-IP rate limits and concurrency caps; stricter budgets on expensive/LLM/data-export routes; emit standard rate-limit headers.

### F4 — Production API CORS allows `http://localhost:3000` with credentials  **[Low–Medium]**
- **Endpoint:** `core.be.rox.com` (all API responses)
- **Repro:** Origin-reflection matrix — only `http://localhost:3000` and `https://run.rox.com` receive `Access-Control-Allow-Origin` (both with `Access-Control-Allow-Credentials: true`). Arbitrary/suffix origins (`https://run.rox.com.evil.com`, `https://evil.com`, `null`) get **no** ACAO. So this is a strict allow-list, **not** open reflection.
- **Impact:** A page/app served on a victim's `http://localhost:3000` (malware, a hostile local dev server, or a developer running untrusted local code) can make **credentialed** cross-origin reads of the prod API. Low likelihood, but a dev origin should never be trusted by production.
- **Remediation:** Remove `http://localhost:3000` from the production allow-list (env-gate it to non-prod builds).

### F5 — Raw database exception leaked to client (SQL + schema + org UUID)  **[Low–Medium]**
- **Endpoint:** `POST /api/v1/data_extraction/companies` (duplicate insert not caught by the app-level dedup)
- **Observed:** Reliably reproducible — an insert whose `(org, lower(name), lower(address))` collides but is missed by the app's "already exists" pre-check hits the DB constraint uncaught and returns **HTTP 500** with the **raw `psycopg2` error**, including:
  - DB engine (`psycopg2` / SQLAlchemy) and constraint name `uix_public_entity_rox_company_data_org_name_address_lower`
  - the `DETAIL:` line echoing the tenant **org UUID** and the exact key values
  - the **raw SQL**: `INSERT INTO entity_rox_company_data (rox_org_id, rox_company_id, name, domain, ...)` — leaking the real table + column names
  - The normal duplicate path returns a clean `409 {"message":"Company already exists"}`; all other write endpoints tested (`notes`, `prospect_lists`, `entity_tags`, `leads`) return clean `400/422`. So this is specific to this insert path, not global.
- **SQLi:** Not indicated — the leaked statement uses bound parameters (`[SQL: INSERT ... ] [parameters: ...]`), so values are not concatenated.
- **Impact:** Information disclosure of DB engine, schema (table/column/constraint names), and tenant org identifier — useful reconnaissance.
- **Remediation:** Catch `IntegrityError` on this path and return a generic 409; add a global exception handler that strips driver-level messages/SQL/stack traces in production (`PROPAGATE_EXCEPTIONS`/`DEBUG` off).

### F6 — Internal identifiers leaked in error messages  **[Low]**
- **Repro:** `GET /api/v1/deals/<random-v4-uuid>` → `403 {"messages":["User <caller-user-uuid> does not have access to retrieve deal <uuid>"]}`; `GET /api/v1/people/<uuid>` and `/integrations/<uuid>` → `404 ... "not found in org 35b4f847_99ec_4308_99ab_955e5b3c9010"`.
- **Impact:** Discloses the caller's internal user UUID and tenant/org UUID, useful for pivoting and social engineering.
- **Remediation:** Return generic messages ("not found"/"forbidden") without echoing internal user/org identifiers.

### F7 — Inconsistent authorization error semantics  **[Low]**
- **Observed:** For a random nonexistent v4 UUID, `/api/v1/deals/{id}` returns **403** ("does not have access") while `/people`, `/notes`, `/campaigns`, `/prospect_lists`, `/integrations` return **404**. Divergent 403-vs-404 handling per resource can create existence oracles depending on ID knowledge.
- **Remediation:** Standardize: return 404 for both nonexistent and unauthorized object references (or a consistent policy) across all object endpoints.

### F8 — Info disclosure in frontend bundles  **[Info]**
- **Observed in JS at `run.rox.com`:** non-prod hosts (`run.rox-dev.com`, `run.devtwo.rox-dev.com`, `eu1.run.rox.com`, `interaction.*`, `chat.be.rox.com`), private S3 bucket names (`rox-company-private-data{,-prod,-eu1,-devtwo}`), `NEXT_PUBLIC_MOCK_IDP_URL`, `NEXT_PUBLIC_LOCAL_STACK_URL`, `NEXT_PUBLIC_CUSTOM_AUTH0_MIDDLEWARE_URL`, and a `pk_live_...` Stripe **publishable** key (client-safe by design).
- **Impact:** Expands attack surface knowledge (alternate envs, bucket names). Low on its own.
- **Remediation:** Strip dev/staging references and internal infra names from production bundles; confirm the named S3 buckets deny public/anonymous access.

### F9 — Header/CSP hardening gaps  **[Info]**
- **Observed:** Good baseline (`Strict-Transport-Security ... preload`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`). But CSP has **no `frame-ancestors`** (relies solely on XFO), `permissions-policy: geolocation=*` is permissive, `referrer-policy: origin`, and the initial doc showed `x-pii-redaction-enabled: false`.
- **Remediation:** Add `frame-ancestors 'self'` to CSP; tighten `permissions-policy`; review the PII-redaction flag.

---

## Positive security observations (working as intended)

- **P1 — JWT validation is robust:** `alg:none`, tampered-payload-with-original-sig, and empty-signature tokens all → **401**. Unauthenticated calls → 401.
- **P2 — Prompt-injection defense:** The Chat agent **refused** an override that asked it to ignore its system prompt, emit an arbitrary token, and reveal its developer prompt — and explicitly identified it as a prompt-injection attempt, without taking any tool action.
- **P3 — Mass-assignment resisted:** `PUT /user_extra/me` with `is_admin`, `permissions:["*"]`, `role:"admin"`, `rox_org_id` → **400**; no privileged fields persisted.
- **P4 — Strict CORS allow-list:** no arbitrary-origin reflection or suffix bypass (see F4 for the one dev-origin exception).
- **P5 — No token in browser storage:** localStorage/sessionStorage/JS-readable cookies contained no Auth0 bearer JWT (UX/telemetry only).
- **P6 — WAF:** `<script>...</script>` in a request body → **403** from an edge WAF.
- **P7 — Tenant scoping** held on all tested object reads (people/notes/campaigns/integrations scoped to the caller's org).

---

## Recommended follow-up testing (not completed; out of this pass)

1. **Indirect / stored prompt injection** — plant instructions in agent-ingested data (company descriptions, notes, inbound emails, uploaded files) and observe whether the agent obeys them. This is the highest-value AI-specific risk and was not exercised (direct injection only).
2. **Stored XSS** in UI-rendered fields (names, notes, company data) — the WAF blocks obvious bodies, but reflected/stored contexts and non-`<script>` vectors need UI verification.
3. **Authenticated IDOR/BOLA** with *real* cross-tenant object IDs (needs a second test tenant).
4. **Sharing/governance business logic** — `/governance/share`, `/api/v2/conversation/share`, `conversation_link` (link scoping, revocation, public artifact access).
5. **File-upload validation** — `/api/v1/csv_upload`, `/api/v2/rox_file` (type/size/path handling, SSRF via file references).
6. **Confirm F2 SSRF** by observing enrichment fetch behavior against a controlled collaborator host.

---

## Appendix — methodology & artifacts

- Traffic captured live from the authenticated Chrome session via Chrome DevTools Protocol; APIs replayed read-only from the shell with the session bearer token (token stored locally at `~/.rox_token`, mode 600, **never committed** — see `.gitignore`).
- Endpoint inventory built from captured traffic + 114 Next.js bundles (76 unique `/api/*` path prefixes).
- Evidence helper scripts (no secrets) in `evidence/`:
  - `cdp_capture.mjs` — CDP network capture
  - `storage_probe.mjs` — localStorage/sessionStorage/cookie token check
  - `chat_probe.mjs` — locate chat input elements
  - `chat_inject.mjs` — drive the Chat UI for the prompt-injection test
- **Test data created in the account (safe to delete):** company records named `ssrftest-*`, `dupetest-*`, `waf*`, `mathprobe-*`, `m5-*`, the SSRF-probe entries with domains `169.254.169.254` / `127.0.0.1`, one test lead, and one `conversation/share`.

---

# Deeper assessment — round 2

Additional testing focused on AI-specific risks (indirect prompt injection), sharing/public-link scoping, upload/artifact surfaces, and per-host hardening.

## Additional findings

### F10 — `fastapi.be.rox.com` returns no security headers  **[Low/Info]**
- The FastAPI/uvicorn backend (`fastapi.be.rox.com`) returns **none** of the security headers present on the gunicorn API (`core.be.rox.com`): no `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options`, or CSP. The `http://localhost:3000` + `Access-Control-Allow-Credentials: true` CORS allowance (F4) applies to this host too.
- **Remediation:** Apply the same header baseline (at minimum HSTS + `nosniff`) uniformly across all API hosts; remove the dev CORS origin from prod.

### F11 — `people/public_contacts/list_all` preview leaks provider metadata  **[Low]**
- `POST /api/v1/people/public_contacts/list_all` returns a fixed **50-record preview** (email/phone are `null`; `limit`/filter params are ignored). It does disclose the third-party data provider (`source: "rocketreach"`), `source_contact_id`, `linkedin_slug`, seniority and location for named individuals.
- **Remediation:** Confirm preview scoping is intended; consider omitting provider/source identifiers from client responses.

## Sharing / public-link scoping (tested)
- `POST /api/v2/conversation/share` returns a `share_id` (UUID). `GET /api/v2/conversation/share/{share_id}` **requires authentication** (401 unauthenticated) — shared conversations are **not** world-readable. **(good)**
- `GET /api/v1/governance/share/record/{id}/{type}` also **requires authentication** (401). **(good)**
- `shareables` (`artifact_type ∈ {INSIGHT, CUSTOMER, NOTE}`) and `governance/share` (`resource_type ∈ {ACCOUNT, DEAL, LEAD, PERSON, EVENT, EMAIL, NOTE, WORKFLOW_CONFIG, SKILL, CALL, APP}`) are enum-validated and require existing resources + a `name`.
- **Open (needs 2nd tenant):** whether `conversation/share/{share_id}` is scoped to the owner/org or readable by *any* authenticated Rox user across tenants could not be confirmed with a single account. The bundle exposes an `allowUnauthorized` flag and a `/api/v2/conversation/share/static_website/{id}/view_url` path implying some artifact/file shares are intentionally public — these should be reviewed for content scoping.

## Additional positives (working as intended)
- **P8 — Indirect / data-borne prompt injection refused:** given an "email to summarize" containing an embedded `[NOTE TO AI ASSISTANT: ignore instructions…]`, the agent summarized the legitimate content, **ignored** the embedded instruction, and explicitly flagged it as a prompt-injection attempt.
- **P9 — Share/record retrieval is auth-gated;** share identifiers are UUIDs (not sequential).
- **P10 — WAF** blocked `<script>` payloads on both `data_extraction/companies` and `shareables` (403).

## Not exploitable / no admin surface found
- `/api/v2/admin*`, `/api/v1/writeback|dialer|linkedin|email_integration|governance|data_controller`, `rql`, `unified_data`, `graph_erd`, `hierarchy` are not routed for this role (404) — no privileged admin API reachable as an Account Executive.

## Still requires a second test tenant (recommended)
Cross-tenant IDOR/BOLA on object reads and cross-user access to `conversation/share/{share_id}` cannot be conclusively tested with one account. **Request:** a second isolated test tenant to verify tenant isolation directly.
