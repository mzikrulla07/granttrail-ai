# Database

PostgreSQL schema for GrantTrail AI.

| File | Purpose |
|------|---------|
| `migrations/001_initial_schema.sql` | Tables, foreign keys, indexes, and integrity triggers |

Migrations are plain SQL, applied in filename order by `npm run db:migrate`
(`server/src/db/migrate.ts`). Applied files are recorded in
`schema_migrations` with a SHA-256 checksum; editing an applied migration is
detected and refused — add a new numbered file instead.

## Tables

```
users ─────────────┐
partner_agencies ◄─┤ (users.partner_agency_id, for future partner access)
documents ◄────────┤ uploaded_by
subawards ─────────┘ created_by
  ├── document_id        → documents      (1:1)
  ├── partner_agency_id  → partner_agencies
  ├── extracted_fields   (1:6, one per extracted field)
  ├── approvals          (0..1, frozen snapshot of approved values)
  └── audit_events       (append-only log)
```

## Integrity rules enforced in the database

* `audit_events` and `approvals` are **append-only** — UPDATE/DELETE raise an error.
* `extracted_fields.ai_value / ai_confidence / source_excerpt` are **immutable** after
  insert, so the original AI output can always be compared with the reviewer's value.
* No password columns. Production identities come from Amazon Cognito (`cognito_sub`).

## Engines

* **Embedded (default for local dev):** leave `DATABASE_URL` empty. PGlite — PostgreSQL
  compiled to WebAssembly — stores data in `.data/pglite`. Nothing to install.
* **PostgreSQL / Amazon RDS:** set `DATABASE_URL` (and `DATABASE_SSL=true` for RDS).
  The same migration files run unchanged.

`npm run db:reset` deletes the embedded database (it refuses to touch a
`DATABASE_URL` database) and re-seeds demo data.
