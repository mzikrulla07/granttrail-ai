-- GrantTrail AI — initial schema
-- PostgreSQL 13+ (gen_random_uuid() is built in). Runs unchanged on local
-- PostgreSQL, Amazon RDS for PostgreSQL, and the embedded PGlite dev database.

-- ------------------------------------------------------------------
-- Shared trigger: maintain updated_at
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ------------------------------------------------------------------
-- users — application identities. No passwords are stored here:
-- in production, credentials live in Amazon Cognito and users are
-- linked by cognito_sub (the token "sub" claim).
-- ------------------------------------------------------------------
CREATE TABLE users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email        text NOT NULL UNIQUE,
  full_name    text NOT NULL,
  role         text NOT NULL CHECK (role IN ('grants_specialist', 'finance_director', 'partner_agency', 'admin')),
  cognito_sub  text UNIQUE,
  partner_agency_id uuid,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------------
-- partner_agencies — subrecipient organizations
-- ------------------------------------------------------------------
CREATE TABLE partner_agencies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  uei           char(12) UNIQUE,
  city          text,
  state         char(2),
  contact_email text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX partner_agencies_name_idx ON partner_agencies (lower(name));
CREATE TRIGGER partner_agencies_updated_at BEFORE UPDATE ON partner_agencies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE users
  ADD CONSTRAINT users_partner_agency_fk FOREIGN KEY (partner_agency_id)
  REFERENCES partner_agencies (id) ON DELETE SET NULL;

-- ------------------------------------------------------------------
-- documents — uploaded agreements. The file itself lives in object
-- storage (local disk in dev, encrypted S3 in production); only a
-- server-generated storage key is kept here, never a user path.
-- ------------------------------------------------------------------
CREATE TABLE documents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  original_filename text NOT NULL,
  storage_driver    text NOT NULL CHECK (storage_driver IN ('local', 's3')),
  storage_key       text NOT NULL UNIQUE,
  mime_type         text NOT NULL,
  size_bytes        integer NOT NULL CHECK (size_bytes > 0),
  sha256            char(64) NOT NULL UNIQUE,
  page_count        integer,
  extracted_text    text NOT NULL,
  uploaded_by       uuid NOT NULL REFERENCES users (id),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_uploaded_by_idx ON documents (uploaded_by);

-- ------------------------------------------------------------------
-- subawards — one reportable subaward per uploaded agreement.
-- Typed columns hold the *current reviewed* values used for
-- querying, due dates, and export. Original AI output is preserved
-- separately in extracted_fields.
-- ------------------------------------------------------------------
CREATE TABLE subawards (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id           uuid NOT NULL UNIQUE REFERENCES documents (id) ON DELETE RESTRICT,
  partner_agency_id     uuid REFERENCES partner_agencies (id) ON DELETE SET NULL,
  status                text NOT NULL DEFAULT 'awaiting_review'
                          CHECK (status IN ('awaiting_review', 'approved', 'reported')),
  subrecipient_name     text,
  uei                   text,
  amount                numeric(14, 2),
  award_date            date,
  place_of_performance  text,
  project_description   text,
  due_date              date,
  validation_status     text NOT NULL DEFAULT 'ERROR'
                          CHECK (validation_status IN ('PASS', 'WARNING', 'ERROR')),
  validation_results    jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_validated_at     timestamptz,
  extraction_mode       text NOT NULL CHECK (extraction_mode IN ('demo', 'claude')),
  extraction_status     text NOT NULL DEFAULT 'completed'
                          CHECK (extraction_status IN ('completed', 'failed')),
  extraction_model      text,
  exported_at           timestamptz,
  reported_at           timestamptz,
  created_by            uuid NOT NULL REFERENCES users (id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subawards_status_idx ON subawards (status);
CREATE INDEX subawards_due_date_idx ON subawards (due_date);
CREATE INDEX subawards_award_date_idx ON subawards (award_date);
CREATE INDEX subawards_partner_agency_idx ON subawards (partner_agency_id);
CREATE INDEX subawards_uei_idx ON subawards (uei);
CREATE TRIGGER subawards_updated_at BEFORE UPDATE ON subawards
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------------
-- extracted_fields — one row per field per subaward.
-- ai_* columns are written once by the extractor and never changed,
-- so the original machine output is always recoverable. Reviewer
-- corrections go to current_value and are recorded in audit_events.
-- ------------------------------------------------------------------
CREATE TABLE extracted_fields (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subaward_id      uuid NOT NULL REFERENCES subawards (id) ON DELETE CASCADE,
  field_name       text NOT NULL CHECK (field_name IN (
                     'subrecipientName', 'uei', 'amount', 'awardDate',
                     'placeOfPerformance', 'projectDescription')),
  ai_value         text,
  ai_confidence    numeric(4, 3) NOT NULL CHECK (ai_confidence BETWEEN 0 AND 1),
  source_excerpt   text,
  current_value    text,
  is_human_edited  boolean NOT NULL DEFAULT false,
  edited_by        uuid REFERENCES users (id),
  edited_at        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subaward_id, field_name)
);
CREATE TRIGGER extracted_fields_updated_at BEFORE UPDATE ON extracted_fields
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Guard: the original AI output may never be rewritten.
CREATE OR REPLACE FUNCTION protect_ai_output() RETURNS trigger AS $$
BEGIN
  IF NEW.ai_value IS DISTINCT FROM OLD.ai_value
     OR NEW.ai_confidence IS DISTINCT FROM OLD.ai_confidence
     OR NEW.source_excerpt IS DISTINCT FROM OLD.source_excerpt THEN
    RAISE EXCEPTION 'Original AI extraction output is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER extracted_fields_protect_ai BEFORE UPDATE ON extracted_fields
  FOR EACH ROW EXECUTE FUNCTION protect_ai_output();

-- ------------------------------------------------------------------
-- approvals — the human decision. One per subaward, with a frozen
-- snapshot of exactly what was approved.
-- ------------------------------------------------------------------
CREATE TABLE approvals (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subaward_id                uuid NOT NULL UNIQUE REFERENCES subawards (id) ON DELETE RESTRICT,
  approved_by                uuid NOT NULL REFERENCES users (id),
  approved_at                timestamptz NOT NULL DEFAULT now(),
  attestation                text NOT NULL,
  validation_status_at_approval text NOT NULL CHECK (validation_status_at_approval IN ('PASS', 'WARNING')),
  snapshot                   jsonb NOT NULL,
  created_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approvals_approved_by_idx ON approvals (approved_by);

CREATE OR REPLACE FUNCTION reject_modification() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER approvals_append_only BEFORE UPDATE OR DELETE ON approvals
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

-- ------------------------------------------------------------------
-- audit_events — append-only compliance log
-- ------------------------------------------------------------------
CREATE TABLE audit_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subaward_id    uuid REFERENCES subawards (id) ON DELETE RESTRICT,
  event_type     text NOT NULL CHECK (event_type IN (
                   'document_uploaded', 'ai_extraction_completed', 'ai_extraction_failed',
                   'field_edited', 'validation_performed', 'record_approved',
                   'export_generated', 'status_changed')),
  actor          text NOT NULL,
  actor_user_id  uuid REFERENCES users (id),
  "timestamp"    timestamptz NOT NULL DEFAULT clock_timestamp(),
  details        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_events_subaward_idx ON audit_events (subaward_id, "timestamp" DESC);
CREATE INDEX audit_events_type_idx ON audit_events (event_type);
CREATE INDEX audit_events_timestamp_idx ON audit_events ("timestamp" DESC);
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_modification();
