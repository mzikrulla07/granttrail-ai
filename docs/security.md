# Security design

| Control | Implementation | Where |
|---|---|---|
| Secrets in environment only | `.env` (git-ignored); `.env.example` has placeholders only; config validation prints variable names, never values | `server/src/config.ts`, `.gitignore` |
| AI calls server-side | Browser only calls `/api`; Anthropic SDK used only in the server; key never serialised | `server/src/ai/claudeExtractor.ts`, `client/src/api/client.ts` |
| Request size limits | JSON 100 KB, urlencoded 10 KB, PDF `MAX_UPLOAD_MB` (default 10), 1 file, ≤ 6 multipart parts | `server/src/app.ts`, `routes/api.ts` |
| PDF type validation | Extension + MIME allow-list at upload, then `%PDF-` magic bytes on the server (client also checks first) | `routes/api.ts`, `pdf/pdf.ts`, `client/src/lib/uploadValidation.ts` |
| Safe file handling | Memory storage (no temp files), random `agreements/<uuid>.pdf` keys, key pattern + path-escape check, `0600` permissions, write-exclusive flag, original name sanitised for display only | `storage/index.ts`, `pdf/pdf.ts` |
| Duplicate protection | SHA-256 unique index on documents | migration, `subawardService.ts` |
| Rate limiting | Global `/api` limiter + stricter upload limiter; standard `RateLimit` headers | `app.ts`, `routes/api.ts` |
| Input validation | zod schemas for every body, query and path parameter; unknown fields rejected (`strict`) | `routes/api.ts`, `http/validate.ts` |
| Sanitised errors | `{code, message, requestId}`; 5xx → generic message, full error logged server-side with request ID; SDK/SQL/stack text never sent | `http/errors.ts`, `client/src/api/client.ts` |
| Secure headers | helmet: CSP (`default-src 'self'`, no inline scripts), `frame-ancestors 'self'`, nosniff, referrer-policy, COOP/CORP, HSTS in production; `x-powered-by` removed | `app.ts` |
| CORS | Only `CLIENT_ORIGIN` (dev); production is same-origin | `app.ts` |
| Authentication | Dev: seeded demo users (refused in production). Prod: Cognito access tokens verified with `aws-jwt-verify` (signature/JWKS, issuer, client ID, token use, expiry) | `auth/index.ts` |
| Authorization | Role → permission matrix enforced on every route; UI mirrors it | `auth/index.ts`, `routes/api.ts` |
| No stored passwords | `users` has no credential columns; linked to Cognito by `cognito_sub` | migration |
| Audit integrity | `audit_events` and `approvals` append-only (DB triggers); AI output immutable; approved records locked | migration, `subawardService.ts` |
| Human approval gate | Server re-validates inside the approval transaction and refuses on any ERROR; attestation required | `subawardService.ts` |
| Prompt injection | Agreement wrapped in `<agreement>` tags and declared untrusted; model can only return schema data; no tools with side effects; output grounded against the document; a human approves | `claudeExtractor.ts`, `responseParser.ts` |
| CSV injection | Cells beginning with `= + - @ \t \r` prefixed with `'` | `services/csv.ts` |
| Least-privilege cloud access | ECS task role for S3/KMS; secrets from Secrets Manager; RDS over TLS | `infra/`, `docs/aws-deployment.md` |

## Where Amazon Cognito connects

1. **Client**: add Cognito Hosted UI sign-in (authorization code + PKCE, e.g.
   `aws-amplify/auth`). Store tokens in memory, not `localStorage`.
2. **Client**: in `client/src/api/client.ts`, replace `authHeaders()` with
   `{ Authorization: 'Bearer ' + accessToken }`, and remove the demo-user switcher
   (it only renders when the server reports `auth: 'dev'`).
3. **Server**: set `AUTH_MODE=cognito`, `COGNITO_USER_POOL_ID`,
   `COGNITO_CLIENT_ID`. `cognitoAuthenticator()` in `server/src/auth/index.ts`
   verifies the token and maps `sub` → `users.cognito_sub`.
4. **Provisioning**: insert a `users` row per staff member with their Cognito `sub`
   and role (or map Cognito groups to roles).

## Residual risks / next steps

* CSRF: in production, bearer tokens are not sent automatically, so the design
  is not CSRF-exposed. In local dev auth, the server falls back to a default demo
  user when no header is sent; a security test found that a hostile web page could
  therefore POST a cross-site multipart form to a running local server. Fixed:
  every state-changing request in dev mode must carry `X-Demo-User` or
  `X-Requested-With: GrantTrail`. Browsers cannot add custom headers cross-site
  without a CORS preflight, and the CORS allow-list rejects foreign origins
  (regression test in `tests/api/api.test.ts`).
* HSTS and `upgrade-insecure-requests` are sent only when `NODE_ENV=production`
  (localhost runs on plain HTTP).
* Malware scanning of uploads (e.g. S3 + GuardDuty Malware Protection).
* Field-level encryption is not needed for current data (no SSNs/bank data), but
  review before adding partner banking information.
* Centralised log redaction policy for CloudWatch.
