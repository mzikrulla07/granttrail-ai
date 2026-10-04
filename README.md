# GrantTrail AI

**Subaward Reporting Assistant for Riverbend Housing Coalition** *(fictional organization)*

> **AI extracts. Code validates. Humans approve.**

GrantTrail AI turns signed federal subaward agreements (PDF) into validated,
review-ready subaward reporting records. It reads each agreement, proposes the six
reportable data elements with confidence scores and verbatim source excerpts,
checks them with deterministic compliance rules, and puts a Grants Specialist in
charge of every correction and every approval — with a complete, append-only audit
trail and a SAM.gov-ready CSV export.

AIML-515 — Full-Stack Application #2.

---

## Contents

1. [The problem](#the-problem)
2. [What it does](#what-it-does)
3. [Architecture](#architecture)
4. [Technologies](#technologies)
5. [Prerequisites](#prerequisites)
6. [Installation](#installation)
7. [Environment variables](#environment-variables)
8. [Database setup](#database-setup)
9. [Running locally](#running-locally)
10. [Demo mode](#demo-mode)
11. [Claude integration](#claude-integration)
12. [Testing](#testing)
13. [Production AWS architecture](#production-aws-architecture)
14. [Security considerations](#security-considerations)
15. [Project structure](#project-structure)
16. [Known limitations](#known-limitations)

---

## The problem

Riverbend Housing Coalition receives about **$12M/year** in federal housing and
homelessness grants and passes much of it to ~40 partner agencies as subawards.
Today the grants team re-keys each signed agreement into spreadsheets (~45 minutes
per record), which leads to missed deadlines, wrong UEIs, wrong amounts,
inconsistent descriptions, and repeated back-and-forth with partners.

## What it does

| Step | Who / what | Where |
|---|---|---|
| 1. Upload a signed agreement (drag-and-drop PDF) | Grants Specialist | Upload Agreement |
| 2. Text extracted from the PDF | Server (`pdf-parse`) | `server/src/pdf` |
| 3. Six fields extracted with confidence + source excerpt | **Claude** (or demo simulator) | `server/src/ai` |
| 4. Excerpts verified against the PDF text; ungrounded values down-scored | Code | `ai/responseParser.ts` |
| 5. Compliance rules applied: PASS / WARNING / ERROR | **Deterministic TypeScript** | `domain/validation.ts` |
| 6. Side-by-side review, live re-validation of edits | Grants Specialist | Review screen |
| 7. Approval (blocked while any ERROR remains, with attestation) | **Human** | Review screen |
| 8. Every action written to an append-only audit trail | Database | `audit_events` |
| 9. SAM.gov-ready CSV export, then "mark as reported" | Specialist / Finance | Review, Dashboard |

**Extracted fields:** subrecipient name, UEI, subaward amount, award date, place of
performance, project description — each returned as
`{ "value": ..., "confidence": 0.00–1.00, "sourceExcerpt": "..." }`. When a value
cannot be found, `value` is `null`, confidence is ≤ 0.10, and the review screen
shows "No supporting text was found — human review required".

**Validation rules** (`server/src/domain/validation.ts`):

| Rule | Result |
|---|---|
| Required fields — all six must be present | ERROR if missing |
| UEI format — 12 chars, A–Z/0–9, never `I` or `O`, no leading `0` | ERROR |
| Valid monetary amount — positive, ≤ 2 decimals, plausible | ERROR |
| Reporting threshold — ≥ $30,000 must be reported (2 CFR 170) | WARNING if below |
| Valid award date — real calendar date, not in the future | ERROR; WARNING if > 3 yrs old |
| Reporting due date — end of the month following the award month | computed |
| Overdue / due soon (≤ 30 days) | WARNING (never blocks approval) |
| Place of performance includes state + ZIP | WARNING |
| Description length (≥ 20, ≤ 4,000 chars) | WARNING / ERROR |
| AI confidence below 75% and not yet human-edited | WARNING |

Only **ERROR** blocks approval. Every result carries a human-readable explanation.

**Users:** *Grants Specialists* upload, review, correct, approve, export.
*Finance Directors* get read-only dashboards, records, exports and the audit trail.
*Partner Agencies* exist in the role model but have no access in this MVP (a future
release will let them correct their own organization's information).

## Architecture

```
 Browser (React + TypeScript + Vite)
   │  same-origin /api calls only — no API keys, no AI calls in the browser
   ▼
 Express API (Node.js + TypeScript)
   ├─ helmet (CSP/HSTS…) · CORS allow-list · rate limits · body-size limits
   ├─ authenticate  ── dev: seeded demo users │ prod: Amazon Cognito JWT
   ├─ requirePermission(role → permission matrix)
   ├─ zod input validation · sanitized errors with request IDs
   └─ SubawardService
        ├─ PDF: magic-byte check → SHA-256 dedupe → pdf-parse text
        ├─ DocumentStorage: local disk │ Amazon S3 (SSE-KMS)
        ├─ Extractor: ClaudeExtractor (tool-forced JSON) │ DemoExtractor
        ├─ responseParser: schema check + excerpt grounding
        ├─ validation.ts: deterministic rules  ◄── the only compliance logic
        └─ Db: PostgreSQL (pg) │ embedded PGlite  ── same SQL migrations
```

More detail: [`docs/architecture.md`](docs/architecture.md).

## Technologies

| Layer | Technology |
|---|---|
| Frontend | React 19, TypeScript, Vite, React Router |
| Backend | Node.js 20+/22, Express 5, TypeScript, zod |
| Database | PostgreSQL 13+ (Amazon RDS in production); PGlite (PostgreSQL-in-WASM) for zero-install local dev and tests |
| AI | Claude via `@anthropic-ai/sdk`, server-side, forced tool use for structured JSON |
| PDF | `pdf-parse` (server-side text extraction); `pdf-lib` to generate fictional demo agreements |
| Security | helmet, express-rate-limit, multer limits, aws-jwt-verify (Cognito) |
| Storage | Local disk (dev) / Amazon S3 with server-side encryption (prod) |
| Testing | Vitest, Supertest, Playwright (manual E2E run) |
| Deploy | Docker, AWS ECS Fargate, ALB, RDS, S3, Cognito, Secrets Manager |

## Prerequisites

* **Node.js 20.16+ or 22+** (tested on Node 22) and npm 10+
* Nothing else for local development — the embedded database needs no install
* Optional: PostgreSQL 13+ (or Docker) to run against a real Postgres server
* Optional: an Anthropic API key to use Claude instead of demo mode

## Installation

```bash
cd granttrail-ai
npm install          # installs server + client (npm workspaces)
cp .env.example .env # optional — every default works for demo mode
```

On Windows PowerShell use `Copy-Item .env.example .env`.

## Environment variables

All configuration is validated at startup (`server/src/config.ts`); invalid values
stop the server with a message naming the variable (never its value).

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | API port |
| `CLIENT_ORIGIN` | `http://localhost:5173` | Only origin allowed by CORS |
| `DATABASE_URL` | *(empty)* | Empty → embedded PGlite. Set for Postgres/RDS |
| `PGLITE_DATA_DIR` | `./.data/pglite` | Embedded DB location |
| `DATABASE_SSL` | `false` | `true` for RDS |
| `AUTO_SEED` | `true` | Seed demo data into an empty DB on start |
| `AI_MODE` | `auto` | `auto` (Claude if key present), `demo`, or `claude` |
| `ANTHROPIC_API_KEY` | *(empty)* | **Server-side only.** Never prefix with `VITE_` |
| `CLAUDE_MODEL` | `claude-sonnet-5` | Model used for extraction |
| `AI_TIMEOUT_MS` / `AI_MAX_INPUT_CHARS` | `60000` / `120000` | Model call limits |
| `STORAGE_DRIVER` | `local` | `local` or `s3` |
| `LOCAL_STORAGE_DIR` | `./storage/uploads` | Where dev uploads are stored |
| `S3_BUCKET`, `S3_KMS_KEY_ID`, `AWS_REGION` | | S3 settings |
| `AUTH_MODE` | `dev` | `dev` (demo users) or `cognito` |
| `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID` | | Cognito settings |
| `MAX_UPLOAD_MB` | `10` | PDF size limit |
| `RATE_LIMIT_MAX_REQUESTS` | `1500` | Requests per client per 15-minute window (`/api/health` not counted) |
| `UPLOAD_RATE_LIMIT_MAX` | `30` | Uploads per client per window |
| `REPORTING_THRESHOLD` | `30000` | Federal reporting threshold ($) |
| `DUE_SOON_DAYS` | `30` | "Due soon" window |
| `LOW_CONFIDENCE_THRESHOLD` | `0.75` | Below this, a value must be verified |
| `PRIME_AWARDEE_NAME`, `PRIME_AWARD_ID` | fictional | Written into the export |

## Database setup

Schema: [`database/migrations/001_initial_schema.sql`](database/migrations/001_initial_schema.sql)
— `users`, `partner_agencies`, `documents`, `subawards`, `extracted_fields`,
`approvals`, `audit_events` with UUID keys, timestamps, foreign keys, indexes, and
integrity triggers (append-only audit/approvals, immutable AI output). See
[`database/README.md`](database/README.md).

```bash
npm run db:migrate   # apply migrations
npm run db:seed      # migrate + seed fictional demo data (only if empty)
npm run db:reset     # delete the EMBEDDED db + local files, then re-seed
```

The server also migrates automatically on start and seeds an empty database when
`AUTO_SEED=true`, so `npm run dev` alone is enough.

**Using a real PostgreSQL server** (tested with PostgreSQL 16):

```bash
docker run -d --name granttrail-pg -p 5432:5432 -e POSTGRES_USER=granttrail \
  -e POSTGRES_PASSWORD=granttrail-local-only -e POSTGRES_DB=granttrail postgres:16
# .env
DATABASE_URL=postgres://granttrail:granttrail-local-only@localhost:5432/granttrail
```

For Amazon RDS set `DATABASE_URL` to the RDS endpoint, `DATABASE_SSL=true`, and
`NODE_EXTRA_CA_CERTS` to the RDS CA bundle.

## Running locally

```bash
npm run dev
```

| URL | What |
|---|---|
| **http://localhost:5173** | The application (Vite dev server; proxies `/api`) |
| http://localhost:3001/api/health | API health / active modes |

On the very first start the API spends a few seconds creating and seeding the
database. The page shows "Waiting for the GrantTrail server to start…" and the
terminal may print a few `[vite] http proxy error … ECONNREFUSED` lines during that
window — both are expected and stop once the server banner appears.

Single-port production-style run:

```bash
npm run build
npm start            # → http://localhost:3001 serves the API and the built app
```

Docker (app + PostgreSQL 16): `docker compose up --build` → http://localhost:3001

**Try the workflow:** sample agreements are in [`samples/`](samples/)
(`npm run samples` regenerates them with current dates):

* `sample-01-cedar-hollow-clean.pdf` — clean agreement, high confidence
* `sample-02-lantern-house-bad-uei.pdf` — UEI contains "I" → approval blocked until corrected
* `sample-03-fairview-missing-fields.pdf` — no UEI/amount, vague location → missing-field errors, low confidence

Switch users with the **Signed in as** menu (top right) to see role-based access:
Dana Whitfield / Luis Ortega (Grants Specialists), Marcus Ellery (Finance
Director), Avery Chen (Admin), Jordan Blake (Partner Agency — no access yet).

A step-by-step demo script: [`docs/demo-walkthrough.md`](docs/demo-walkthrough.md).

## Demo mode

When `ANTHROPIC_API_KEY` is not set (or `AI_MODE=demo`), GrantTrail runs in a
clearly labelled **DEMO MODE** (purple banner on every page, "Demo simulator" badge
on each record, and an audit entry saying the values came from the simulator, not
Claude).

| Real in demo mode | Simulated in demo mode |
|---|---|
| PDF upload, type/size checks, SHA-256 duplicate detection | AI extraction → a **rule-based pattern extractor** (`ai/demoExtractor.ts`) returns the same JSON shape with rule-based confidence scores |
| Server-side text extraction with pdf-parse | Authentication → demo users picked from a menu instead of Cognito sign-in |
| Excerpt grounding + all deterministic validation | Document storage → local disk instead of encrypted S3 |
| Review, editing, approval gate, attestation | Database → embedded PGlite by default (real PostgreSQL also supported) |
| Audit trail, CSV export, dashboard, role permissions | Demo data → nine **fictional** agreements generated as real PDFs at first start, with dates relative to today so there is always an overdue record, a due-soon record, etc. |

The simulator runs through the same schema validation and excerpt grounding as
Claude output, so the rest of the pipeline is exercised exactly as in production.
It only understands the fictional agreement template; real agreements need Claude.

## Claude integration

`server/src/ai/claudeExtractor.ts`:

1. **Server-side only.** The key is read from the server environment; the browser
   only talks to `/api`. `GET /api/health` reports the mode, never the key.
2. **Structured output.** Claude is given one tool, `record_subaward_fields`,
   whose `input_schema` is the extraction JSON Schema, and `tool_choice` forces
   that tool — so the answer is always schema-shaped JSON (with a fallback parser
   for JSON in text).
3. **Prompt rules:** extract only what the text states; never guess or calculate;
   `null` + confidence ≤ 0.1 when absent; verbatim excerpts; the agreement is
   untrusted data (prompt-injection guard, wrapped in `<agreement>` tags); **do
   not judge compliance**.
4. **Untrusted output handling** (`responseParser.ts`): zod schema validation;
   confidence normalised/clamped; each excerpt searched for in the PDF text — if
   not found, confidence is capped at 0.40 so a reviewer must verify it.
5. **Failure handling:** timeouts/API errors become a sanitised
   `ai_extraction_failed` audit event; the record is still created with empty
   fields for manual entry. SDK error text is never returned to the browser.

To enable: put `ANTHROPIC_API_KEY=...` in `.env` and restart. Measure accuracy with
the evaluation harness below before relying on it.

## Testing

```bash
npm test             # 123 unit + API tests (Vitest + Supertest), ~5 s, no network
npm run typecheck    # server, client and tests
npm run eval         # extraction accuracy vs labelled agreements
npm run eval -- demo # force the demo simulator
```

| Suite | Covers |
|---|---|
| `tests/unit/uei.test.ts` | UEI format rules and normalisation |
| `tests/unit/validation.test.ts` | Threshold, due-date calculation (incl. year-end, leap year), required fields, amounts, dates, overdue/due-soon, low confidence, **approval blocking**, determinism |
| `tests/unit/aiResponse.test.ts` | **AI response parsing**: schema, nulls, missing fields, hallucinated excerpts, percent confidences, fenced JSON; Claude extractor with a fake client (tool forcing, prompt rules, error sanitising, truncation); demo extractor |
| `tests/unit/csvAndScoring.test.ts` | CSV escaping + formula-injection defence, filename sanitising, evaluation scoring |
| `tests/api/api.test.ts` | **API validation** end-to-end on a real (in-memory) PostgreSQL: auth/roles, upload checks (type, magic bytes, size, corrupt PDF, duplicates), full workflow, approval blocking, edit locking, export, audit order, malformed input, rate limiting, append-only and immutability triggers |

**Evaluation harness** ([`tests/evaluation/`](tests/evaluation/README.md)):
structure for scoring extraction against a **20-agreement labelled set** — per-field
accuracy, fully-correct rate, high-confidence precision, confident errors, and
hallucinations. It currently runs on the 3 fictional samples (100% with the
simulator, which is expected because the simulator was written for that template;
the meaningful number will come from Claude on real agreements).

## Production AWS architecture

```
 Users ─► Route 53 ─► CloudFront/WAF ─► ALB (HTTPS, ACM cert)
                                      │
                           ECS Fargate service (private subnets)
                           granttrail-ai container (this Dockerfile)
            ┌──────────────┬──────────┴─────────┬───────────────────┐
     Amazon Cognito   Amazon RDS for      Amazon S3 bucket     Secrets Manager
     (user pool,      PostgreSQL          (SSE-KMS, block      (DATABASE_URL,
      MFA, groups)    (Multi-AZ, TLS,     public access,       ANTHROPIC_API_KEY)
                       encrypted, PITR)    versioning)
                                      │
                         Claude API (HTTPS egress via NAT)
                         CloudWatch Logs / alarms
```

* **Cognito** — Hosted UI sign-in (PKCE) in the React app; the API verifies access
  tokens in `server/src/auth/index.ts` (`AUTH_MODE=cognito`). `AUTH_MODE=dev` is
  refused when `NODE_ENV=production`.
* **RDS** — same migrations; `DATABASE_SSL=true`.
* **S3** — `STORAGE_DRIVER=s3`; objects written with `aws:kms` encryption using the
  ECS task role (no static keys).
* **ECS** — see [`infra/ecs-task-definition.example.json`](infra/ecs-task-definition.example.json);
  secrets injected from Secrets Manager.

Full guide: [`docs/aws-deployment.md`](docs/aws-deployment.md).

## Security considerations

Applied from lessons of the first application — details in
[`docs/security.md`](docs/security.md):

* Secrets only in environment variables; `.env` git-ignored; `.env.example` has no secrets
* All AI calls server-side; the key never reaches the browser or API responses
* Request size limits (JSON 100 KB, PDF `MAX_UPLOAD_MB`, one file per request)
* PDF validation by **magic bytes**, not filename/MIME; corrupt/encrypted/scanned PDFs rejected with guidance
* Safe file handling — memory upload, random server-generated storage keys, path-traversal guard, `0600` files, SHA-256 dedupe
* Rate limiting (global + stricter upload limiter)
* zod input validation on every body, query and path parameter
* Sanitised errors: `{code, message, requestId}` only; details logged server-side
* Secure headers via helmet (CSP, frame-ancestors, nosniff, referrer policy, HSTS in prod)
* Role-based authorization (permission matrix, server-enforced; UI hides what you can't do)
* No passwords stored — Cognito owns credentials
* Tamper resistance — append-only `audit_events` and `approvals`, immutable AI output, approved records locked
* CSV formula-injection neutralisation; prompt-injection guard; deterministic compliance logic

## Project structure

```
granttrail-ai/
├── client/                 React + TypeScript + Vite
│   └── src/  api/ components/ pages/ lib/ session.tsx styles.css
├── server/                 Express + TypeScript
│   └── src/
│       ├── ai/             Claude extractor, demo simulator, response parser
│       ├── auth/           dev + Cognito authentication, role permissions
│       ├── db/             pg/PGlite layer, migration runner, seed, CLI
│       ├── domain/         fields, parsing, deterministic validation engine
│       ├── evaluation/     accuracy scoring + runner
│       ├── http/           sanitised errors, input validation
│       ├── pdf/            magic-byte check, pdf-parse, filename sanitising
│       ├── routes/         REST API
│       ├── samples/        fictional agreement generator + demo data
│       ├── services/       workflow service, audit, CSV
│       └── storage/        local disk / S3
├── database/migrations/    SQL schema
├── tests/                  unit/ api/ evaluation/
├── docs/                   architecture, security, AWS, API, demo walkthrough
├── samples/                fictional sample agreement PDFs
├── infra/                  ECS task definition example
├── Dockerfile  docker-compose.yml  .env.example  .gitignore
```

## Known limitations

* Scanned (image-only) PDFs are rejected — OCR (e.g. Amazon Textract) is future work.
* The CSV follows federal subaward data elements; map columns to the current SAM.gov
  bulk-upload template before production use (`server/src/services/csv.ts`).
* GrantTrail does not submit to SAM.gov; "Mark as reported" records that a human did.
* Cognito sign-in UI is documented and the server verifier implemented, but it has
  not been exercised against a live user pool in this build. Same for S3 storage,
  ECS, and the Docker image (Docker was not available in the build environment).
* Claude extraction is implemented and unit-tested with a fake client; it has not
  been run against the live API in this build because no key was configured.
* The upload screen's stage list is an elapsed-time indicator; the server processes
  the request as one call.
* All organizations, people, UEIs and agreements in this repository are fictional.

## Deploying to AWS Elastic Beanstalk (public demo)

Every push to `main` is tested, built and deployed by GitHub Actions
(`.github/workflows/deploy.yml`, installed by `scripts/setup-aws.ps1` from `deploy/github-actions-deploy.yml`) to a single-instance **t3.micro** Elastic Beanstalk
environment (Node.js 22, no load balancer). See [docs/deploy-elastic-beanstalk.md](docs/deploy-elastic-beanstalk.md).

```powershell
# one-time setup (Windows, AWS CLI signed in)
powershell -ExecutionPolicy Bypass -File scripts\setup-aws.ps1
# health of all your Elastic Beanstalk environments
powershell -ExecutionPolicy Bypass -File scripts\eb-status.ps1
```
