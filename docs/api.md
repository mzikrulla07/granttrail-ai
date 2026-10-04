# REST API

Base path `/api`. JSON in/out. Errors are always
`{ "error": { "code", "message", "requestId", "details?" } }`.

Authentication: dev mode — `X-Demo-User: <email>` (defaults to the first grants
specialist); Cognito mode — `Authorization: Bearer <access token>`.

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/health` | public | Status, active modes (demo/Claude, DB, storage, auth), limits, rule parameters |
| GET | `/auth/demo-users` | public (dev only) | Users for the demo switcher |
| GET | `/me` | any user | Current user, role, permissions |
| GET | `/dashboard` | `subaward:read` | Summary counts, next deadline |
| GET | `/subawards?filter=&search=` | `subaward:read` | `filter`: all, due_soon, overdue, awaiting_review, approved, reported |
| POST | `/subawards/upload` | `subaward:upload` | multipart field `file` (PDF). 201 → subaward detail |
| GET | `/subawards/:id` | `subaward:read` | Detail: fields (current + AI original, confidence, excerpt), live validation, document, approval |
| GET | `/subawards/:id/document` | `subaward:read` | Original PDF (inline) |
| POST | `/subawards/:id/validate-preview` | `subaward:read` | `{fields}` → validation of unsaved values (nothing stored) |
| POST | `/subawards/:id/validate` | `subaward:edit` | Re-run validation and record an audit event |
| PATCH | `/subawards/:id` | `subaward:edit` | Save draft `{fields: {uei: "..."}}`; each change audited |
| POST | `/subawards/:id/approve` | `subaward:approve` | `{attestation: true, fields?}`; 422 `APPROVAL_BLOCKED` with `details.reasons` if errors remain |
| POST | `/subawards/:id/mark-reported` | `subaward:report` | `{reference?}`; approved → reported |
| GET | `/subawards/:id/export.csv` | `subaward:export` | SAM.gov-ready CSV for one approved/reported record |
| GET | `/exports/approved.csv` | `subaward:export` | CSV of all approved (not yet reported) records |
| GET | `/audit-events?subawardId=&eventType=&limit=&offset=` | `audit:read` | Audit trail, newest first |

Common error codes: `VALIDATION_FAILED`, `NOT_A_PDF`, `FILE_TOO_LARGE`,
`PDF_UNREADABLE`, `PDF_ENCRYPTED`, `NO_TEXT`, `DUPLICATE_DOCUMENT`,
`APPROVAL_BLOCKED`, `ATTESTATION_REQUIRED`, `RECORD_LOCKED`, `NOT_APPROVED`,
`FORBIDDEN`, `UNAUTHENTICATED`, `RATE_LIMITED`, `NOT_FOUND`, `INTERNAL_ERROR`.
