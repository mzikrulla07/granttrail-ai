/**
 * API tests — real Express app, real PostgreSQL (in-memory PGlite), real PDF
 * parsing, demo extractor. No network access required.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../server/src/app.js';
import { DemoExtractor } from '../../server/src/ai/demoExtractor.js';
import { loadConfig } from '../../server/src/config.js';
import { createDb, type Db } from '../../server/src/db/index.js';
import { runMigrations } from '../../server/src/db/migrate.js';
import { seedUsers } from '../../server/src/db/seed.js';
import { renderAgreementPdf, type AgreementSpec } from '../../server/src/samples/agreementPdf.js';
import { LocalStorage } from '../../server/src/storage/index.js';

const TODAY = '2026-09-26';
const SPECIALIST = 'dana.whitfield@riverbend.example';
const FINANCE = 'marcus.ellery@riverbend.example';
const PARTNER = 'jordan.blake@harborlight.example';

const baseSpec: AgreementSpec = {
  agreementNumber: 'TEST-001',
  style: 'labeled',
  subrecipientName: 'Test Housing Partners',
  uei: 'TH4K7TQ2LZ81',
  amount: '$75,000.00',
  awardDate: 'August 20, 2026',
  periodOfPerformance: 'August 20, 2026 through July 31, 2027',
  placeOfPerformance: 'Riverbend, OH 45101',
  subrecipientAddress: '1 Test Way, Riverbend, OH 45101',
  projectDescription: 'Provide rapid rehousing assistance and case management to families experiencing homelessness.',
  signatory: 'Director',
};

let db: Db;
let app: ReturnType<typeof createApp>['app'];
let storageDir: string;

beforeAll(async () => {
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granttrail-test-'));
  const config = loadConfig({ NODE_ENV: 'test', AI_MODE: 'demo', MAX_UPLOAD_MB: '1', UPLOAD_RATE_LIMIT_MAX: '1000' });
  db = await createDb({ pgliteDataDir: 'memory://' });
  await runMigrations(db);
  await seedUsers(db);
  ({ app } = createApp({ config, db, storage: new LocalStorage(storageDir), extractor: new DemoExtractor(0), today: () => TODAY }));
});

afterAll(async () => {
  await db.close();
  fs.rmSync(storageDir, { recursive: true, force: true });
});

const as = (email: string) => ({ 'X-Demo-User': email });

async function upload(spec: Partial<AgreementSpec>, user = SPECIALIST) {
  const pdf = await renderAgreementPdf({ ...baseSpec, ...spec });
  return request(app).post('/api/subawards/upload').set(as(user)).attach('file', pdf, { filename: 'agreement.pdf', contentType: 'application/pdf' });
}

describe('health & auth', () => {
  it('GET /api/health reports demo mode without exposing secrets', async () => {
    const r = await request(app).get('/api/health').expect(200);
    expect(r.body).toMatchObject({ status: 'ok', demoMode: true, modes: { ai: 'demo', database: 'pglite' } });
    expect(JSON.stringify(r.body)).not.toMatch(/key|secret|password/i);
  });

  it('sets secure headers', async () => {
    const r = await request(app).get('/api/health');
    expect(r.headers['content-security-policy']).toContain("default-src 'self'");
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-powered-by']).toBeUndefined();
    const me = await request(app).get('/api/me');
    expect(me.headers['ratelimit-policy'] ?? me.headers['ratelimit']).toBeDefined();
  });

  it('rate-limits with a sanitised 429, without counting health checks', async () => {
    const config = loadConfig({ NODE_ENV: 'test', AI_MODE: 'demo', RATE_LIMIT_MAX_REQUESTS: '10' });
    const limited = createApp({ config, db, storage: new LocalStorage(storageDir), extractor: new DemoExtractor(0), today: () => TODAY }).app;
    for (let i = 0; i < 15; i++) await request(limited).get('/api/health').expect(200);
    for (let i = 0; i < 10; i++) await request(limited).get('/api/me').expect(200);
    const r = await request(limited).get('/api/me').expect(429);
    expect(r.body.error).toMatchObject({ code: 'RATE_LIMITED', message: expect.stringMatching(/Too many requests/) });
    await request(limited).get('/api/health').expect(200);
  });

  it('rejects unknown users', async () => {
    const r = await request(app).get('/api/me').set(as('nobody@example.com')).expect(401);
    expect(r.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('CSRF guard: state-changing requests without an application header are refused', async () => {
    // Simulates a hostile page submitting a cross-site multipart form (no custom headers possible).
    const r = await request(app)
      .post('/api/subawards/upload')
      .attach('file', Buffer.from('%PDF-1.4'), { filename: 'x.pdf', contentType: 'application/pdf' })
      .expect(403);
    expect(r.body.error.code).toBe('CSRF_CHECK_FAILED');
    // Reads stay open in dev mode, and the SPA's X-Requested-With header satisfies the guard.
    await request(app).get('/api/me').expect(200);
    await request(app).post('/api/subawards/upload').set('X-Requested-With', 'GrantTrail').expect(400);
  });

  it('returns role permissions', async () => {
    const r = await request(app).get('/api/me').set(as(FINANCE)).expect(200);
    expect(r.body.user.permissions).toContain('subaward:read');
    expect(r.body.user.permissions).not.toContain('subaward:approve');
  });

  it('partner agency users have no access in the MVP', async () => {
    const r = await request(app).get('/api/subawards').set(as(PARTNER)).expect(403);
    expect(r.body.error.code).toBe('FORBIDDEN');
  });
});

describe('upload validation', () => {
  it('rejects a request with no file', async () => {
    const r = await request(app).post('/api/subawards/upload').set(as(SPECIALIST)).expect(400);
    expect(r.body.error.code).toBe('NO_FILE');
  });

  it('rejects non-PDF extensions', async () => {
    const r = await request(app)
      .post('/api/subawards/upload')
      .set(as(SPECIALIST))
      .attach('file', Buffer.from('hello'), { filename: 'notes.txt', contentType: 'text/plain' })
      .expect(415);
    expect(r.body.error.code).toBe('NOT_A_PDF');
  });

  it('rejects a file named .pdf that is not a PDF (magic-byte check)', async () => {
    const r = await request(app)
      .post('/api/subawards/upload')
      .set(as(SPECIALIST))
      .attach('file', Buffer.from('MZ\x90\x00 executable'), { filename: 'invoice.pdf', contentType: 'application/pdf' })
      .expect(415);
    expect(r.body.error.code).toBe('NOT_A_PDF');
  });

  it('rejects files over the size limit', async () => {
    const big = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(1.2 * 1024 * 1024, 32)]);
    const r = await request(app)
      .post('/api/subawards/upload')
      .set(as(SPECIALIST))
      .attach('file', big, { filename: 'big.pdf', contentType: 'application/pdf' })
      .expect(413);
    expect(r.body.error.message).toMatch(/1 MB limit/);
  });

  it('rejects a corrupt PDF with a friendly message', async () => {
    const r = await request(app)
      .post('/api/subawards/upload')
      .set(as(SPECIALIST))
      .attach('file', Buffer.from('%PDF-1.4\n garbage without structure'), { filename: 'broken.pdf', contentType: 'application/pdf' })
      .expect(422);
    expect(r.body.error.code).toBe('PDF_UNREADABLE');
    expect(r.body.error.message).not.toMatch(/at |Error:|\.ts/);
  });

  it('forbids uploads by the finance director', async () => {
    const r = await upload({ agreementNumber: 'FD-1' }, FINANCE);
    expect(r.status).toBe(403);
  });
});

describe('full workflow: upload → review → approve → export → reported', () => {
  let id: string;

  it('uploads, extracts, validates and audits', async () => {
    const r = await upload({ agreementNumber: 'WF-1', uei: 'TH4I7TQ2LZ81' }); // contains "I" → invalid
    expect(r.status).toBe(201);
    const s = r.body.subaward;
    id = s.id;
    expect(s.status).toBe('awaiting_review');
    expect(s.extraction.mode).toBe('demo');
    expect(s.fields).toHaveLength(6);
    const uei = s.fields.find((f: { name: string }) => f.name === 'uei');
    expect(uei).toMatchObject({ value: 'TH4I7TQ2LZ81', aiValue: 'TH4I7TQ2LZ81', sourceExcerpt: expect.stringContaining('TH4I7TQ2LZ81') });
    expect(uei.confidence).toBeGreaterThan(0.9);
    expect(s.validation.status).toBe('ERROR');
    expect(s.validation.fieldStatus.uei).toBe('ERROR');
    expect(s.dueDate).toBe('2026-09-30');
    expect(s.timeliness).toBe('due_soon');

    const audit = await request(app).get(`/api/audit-events?subawardId=${id}`).set(as(SPECIALIST)).expect(200);
    expect(audit.body.items.map((e: { eventType: string }) => e.eventType).sort()).toEqual(
      ['ai_extraction_completed', 'document_uploaded', 'validation_performed'].sort(),
    );
  });

  it('rejects a duplicate upload of the same PDF', async () => {
    const r = await upload({ agreementNumber: 'WF-1', uei: 'TH4I7TQ2LZ81' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'DUPLICATE_DOCUMENT', details: { subawardId: id } });
  });

  it('serves the original PDF', async () => {
    const r = await request(app).get(`/api/subawards/${id}/document`).set(as(FINANCE)).expect(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.body.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('blocks approval while a blocking validation error remains', async () => {
    const r = await request(app).post(`/api/subawards/${id}/approve`).set(as(SPECIALIST)).send({ attestation: true }).expect(422);
    expect(r.body.error.code).toBe('APPROVAL_BLOCKED');
    expect(r.body.error.details.reasons[0]).toMatch(/UEI/);
    const after = await request(app).get(`/api/subawards/${id}`).set(as(SPECIALIST));
    expect(after.body.subaward.status).toBe('awaiting_review');
  });

  it('requires the reviewer attestation', async () => {
    const r = await request(app).post(`/api/subawards/${id}/approve`).set(as(SPECIALIST)).send({}).expect(400);
    expect(r.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('previews validation for unsaved edits without saving', async () => {
    const r = await request(app)
      .post(`/api/subawards/${id}/validate-preview`)
      .set(as(SPECIALIST))
      .send({ fields: { uei: 'TH4J7TQ2LZ81' } })
      .expect(200);
    expect(r.body.validation.canApprove).toBe(true);
    const still = await request(app).get(`/api/subawards/${id}`).set(as(SPECIALIST));
    expect(still.body.subaward.validation.canApprove).toBe(false);
  });

  it('saves a draft edit, keeps the original AI value, and audits before/after', async () => {
    const r = await request(app).patch(`/api/subawards/${id}`).set(as(SPECIALIST)).send({ fields: { uei: 'th4j-7tq2-lz81' } }).expect(200);
    const uei = r.body.subaward.fields.find((f: { name: string }) => f.name === 'uei');
    expect(uei).toMatchObject({ value: 'th4j-7tq2-lz81', aiValue: 'TH4I7TQ2LZ81', isHumanEdited: true, editedBy: 'Dana Whitfield' });
    expect(r.body.subaward.uei).toBe('TH4J7TQ2LZ81'); // normalised typed column
    expect(r.body.subaward.validation.canApprove).toBe(true);

    const audit = await request(app).get(`/api/audit-events?subawardId=${id}&eventType=field_edited`).set(as(SPECIALIST));
    expect(audit.body.items[0].details).toMatchObject({ field: 'uei', previousValue: 'TH4I7TQ2LZ81', newValue: 'th4j-7tq2-lz81', originalAiValue: 'TH4I7TQ2LZ81' });
    expect(audit.body.items[0].actor).toBe(SPECIALIST);
  });

  it('refuses export before approval', async () => {
    const r = await request(app).get(`/api/subawards/${id}/export.csv`).set(as(SPECIALIST)).expect(409);
    expect(r.body.error.code).toBe('NOT_APPROVED');
  });

  it('refuses approval by the finance director', async () => {
    await request(app).post(`/api/subawards/${id}/approve`).set(as(FINANCE)).send({ attestation: true }).expect(403);
  });

  it('approves once errors are resolved and records the approval', async () => {
    const r = await request(app).post(`/api/subawards/${id}/approve`).set(as(SPECIALIST)).send({ attestation: true }).expect(200);
    expect(r.body.subaward.status).toBe('approved');
    expect(r.body.subaward.approval).toMatchObject({ approvedBy: 'Dana Whitfield', validationStatus: 'WARNING' });
    const snap = await db.query<{ snapshot: { values: { uei: string } } }>('SELECT snapshot FROM approvals WHERE subaward_id = $1', [id]);
    expect(snap.rows[0]!.snapshot.values.uei).toBe('TH4J7TQ2LZ81');
  });

  it('locks approved records against edits and re-approval', async () => {
    const e = await request(app).patch(`/api/subawards/${id}`).set(as(SPECIALIST)).send({ fields: { amount: '1' } }).expect(409);
    expect(e.body.error.code).toBe('RECORD_LOCKED');
    await request(app).post(`/api/subawards/${id}/approve`).set(as(SPECIALIST)).send({ attestation: true }).expect(409);
  });

  it('exports a SAM.gov-ready CSV and audits the export', async () => {
    const r = await request(app).get(`/api/subawards/${id}/export.csv`).set(as(FINANCE)).expect(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.headers['content-disposition']).toMatch(/attachment; filename="granttrail-subaward-/);
    expect(r.text).toContain('Subawardee UEI');
    expect(r.text).toContain('TH4J7TQ2LZ81');
    expect(r.text).toContain('75000.00');
    const audit = await request(app).get(`/api/audit-events?subawardId=${id}&eventType=export_generated`).set(as(SPECIALIST));
    expect(audit.body.total).toBe(1);
  });

  it('marks the record reported', async () => {
    const r = await request(app).post(`/api/subawards/${id}/mark-reported`).set(as(SPECIALIST)).send({ reference: 'SAM-123' }).expect(200);
    expect(r.body.subaward.status).toBe('reported');
    expect(r.body.subaward.timeliness).toBe('reported');
    await request(app).post(`/api/subawards/${id}/mark-reported`).set(as(SPECIALIST)).send({}).expect(409);
  });

  it('shows the complete audit trail in order', async () => {
    const r = await request(app).get(`/api/audit-events?subawardId=${id}&limit=100`).set(as(FINANCE)).expect(200);
    const types = r.body.items.map((e: { eventType: string }) => e.eventType).reverse();
    expect(types[0]).toBe('document_uploaded');
    for (const t of ['ai_extraction_completed', 'field_edited', 'validation_performed', 'record_approved', 'export_generated', 'status_changed']) {
      expect(types).toContain(t);
    }
    expect(types.at(-1)).toBe('status_changed');
  });
});

describe('dashboard and list filters', () => {
  it('counts and filters records', async () => {
    await upload({ agreementNumber: 'OVERDUE-1', subrecipientName: 'Overdue Org', awardDate: 'July 1, 2026' });
    const d = await request(app).get('/api/dashboard').set(as(FINANCE)).expect(200);
    expect(d.body.totals.overdue).toBeGreaterThanOrEqual(1);
    const overdue = await request(app).get('/api/subawards?filter=overdue').set(as(FINANCE)).expect(200);
    expect(overdue.body.items.every((s: { timeliness: string }) => s.timeliness === 'overdue')).toBe(true);
    const reported = await request(app).get('/api/subawards?filter=reported').set(as(FINANCE)).expect(200);
    expect(reported.body.items).toHaveLength(1);
    const search = await request(app).get('/api/subawards?search=overdue%20org').set(as(FINANCE)).expect(200);
    expect(search.body.items).toHaveLength(1);
  });

  it('extracts missing fields as null and blocks approval', async () => {
    const r = await upload({ agreementNumber: 'MISSING-1', style: 'narrative', subrecipientName: 'Sparse Org', uei: null, amount: null });
    const s = r.body.subaward;
    expect(s.fields.find((f: { name: string }) => f.name === 'uei')).toMatchObject({ value: null, confidence: 0, sourceExcerpt: null });
    expect(s.validation.checks.filter((c: { code: string }) => c.code === 'REQUIRED_FIELD').length).toBeGreaterThanOrEqual(2);
    expect(s.validation.canApprove).toBe(false);
  });
});

describe('API input validation and error sanitisation', () => {
  it('rejects malformed ids', async () => {
    const r = await request(app).get('/api/subawards/not-a-uuid').set(as(SPECIALIST)).expect(400);
    expect(r.body.error.details[0].path).toBe('id');
  });

  it('returns 404 for unknown records', async () => {
    await request(app).get('/api/subawards/00000000-0000-4000-8000-000000000000').set(as(SPECIALIST)).expect(404);
  });

  it('rejects unknown fields and bad filters', async () => {
    const list = await request(app).get('/api/subawards').set(as(SPECIALIST));
    const anyId = list.body.items[0].id;
    await request(app).patch(`/api/subawards/${anyId}`).set(as(SPECIALIST)).send({ fields: { status: 'approved' } }).expect(400);
    await request(app).patch(`/api/subawards/${anyId}`).set(as(SPECIALIST)).send({ fields: { uei: 12345 } }).expect(400);
    await request(app).get('/api/subawards?filter=everything').set(as(SPECIALIST)).expect(400);
  });

  it('rejects oversized and malformed JSON bodies', async () => {
    const list = await request(app).get('/api/subawards').set(as(SPECIALIST));
    const anyId = list.body.items[0].id;
    const huge = await request(app)
      .patch(`/api/subawards/${anyId}`)
      .set(as(SPECIALIST))
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ fields: { projectDescription: 'x'.repeat(200_000) } }))
      .expect(413);
    expect(huge.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    const bad = await request(app).patch(`/api/subawards/${anyId}`).set(as(SPECIALIST)).set('Content-Type', 'application/json').send('{"fields": ').expect(400);
    expect(bad.body.error.code).toBe('MALFORMED_JSON');
  });

  it('unknown API routes return a JSON 404', async () => {
    const r = await request(app).get('/api/nope').expect(404);
    expect(r.body.error).toMatchObject({ code: 'NOT_FOUND', requestId: expect.any(String) });
  });
});

describe('database integrity guarantees', () => {
  it('audit events are append-only', async () => {
    await expect(db.query(`UPDATE audit_events SET actor = 'tampered'`)).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM audit_events`)).rejects.toThrow(/append-only/);
  });

  it('approvals are append-only', async () => {
    await expect(db.query(`DELETE FROM approvals`)).rejects.toThrow(/append-only/);
  });

  it('original AI output cannot be overwritten', async () => {
    await expect(db.query(`UPDATE extracted_fields SET ai_value = 'forged'`)).rejects.toThrow(/immutable/);
  });

  it('users table stores no passwords', async () => {
    const { rows } = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'users'`,
    );
    expect(rows.map((r) => r.column_name).join(' ')).not.toMatch(/pass|hash|secret/);
  });
});
