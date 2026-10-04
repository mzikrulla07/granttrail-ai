/**
 * Seeds FICTIONAL demo users and subawards.
 *
 * Records are created through the real workflow (PDF generation → text
 * extraction → demo extraction → validation → approval → reporting) so the
 * audit trail, extracted fields and approvals are exactly what the live
 * application would produce.
 */
import type { AuthUser } from '../auth/index.js';
import type { RulesConfig } from '../config.js';
import type { Db } from './index.js';
import { DemoExtractor } from '../ai/demoExtractor.js';
import { todayIso } from '../domain/parsing.js';
import { renderAgreementPdf } from '../samples/agreementPdf.js';
import { buildDemoRecords, DEMO_USERS } from '../samples/demoData.js';
import type { DocumentStorage } from '../storage/index.js';
import { SubawardService } from '../services/subawardService.js';
import type { FieldName } from '../domain/fields.js';

export async function seedUsers(db: Db): Promise<void> {
  for (const u of DEMO_USERS) {
    await db.query(
      `INSERT INTO users (email, full_name, role) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO NOTHING`,
      [u.email, u.fullName, u.role],
    );
  }
}

async function userByEmail(db: Db, email: string): Promise<AuthUser> {
  const { rows } = await db.query<{ id: string; email: string; full_name: string; role: AuthUser['role'] }>(
    'SELECT id, email, full_name, role FROM users WHERE email = $1',
    [email],
  );
  const r = rows[0];
  if (!r) throw new Error(`Seed user ${email} missing`);
  return { id: r.id, email: r.email, fullName: r.full_name, role: r.role };
}

export async function isDatabaseEmpty(db: Db): Promise<boolean> {
  const { rows } = await db.query<{ n: string | number }>('SELECT count(*) AS n FROM subawards');
  return Number(rows[0]?.n ?? 0) === 0;
}

export async function seedDemoData(
  db: Db,
  storage: DocumentStorage,
  opts: { rules: RulesConfig; exportConfig: { primeAwardeeName: string; primeAwardId: string }; today?: string; log?: (m: string) => void },
): Promise<number> {
  const log = opts.log ?? (() => undefined);
  const today = opts.today ?? todayIso();
  await seedUsers(db);

  const service = new SubawardService({
    db,
    storage,
    extractor: new DemoExtractor(0),
    rules: opts.rules,
    exportConfig: opts.exportConfig,
    today: () => today,
  });

  const uploader = await userByEmail(db, 'dana.whitfield@riverbend.example');
  let count = 0;
  for (const rec of buildDemoRecords(today)) {
    const pdf = await renderAgreementPdf(rec.spec);
    const { subawardId } = await service.ingestDocument({ buffer: pdf, originalName: rec.filename, user: uploader });
    if (rec.outcome !== 'awaiting_review') {
      const approver = await userByEmail(db, rec.approver ?? uploader.email);
      if (rec.corrections) {
        await service.saveDraft(subawardId, rec.corrections as Partial<Record<FieldName, string>>, approver);
      }
      await service.approve(subawardId, { attestation: true }, approver);
      if (rec.outcome === 'reported') {
        await service.exportCsv([subawardId], approver);
        await service.markReported(subawardId, { reference: `DEMO-SUBMISSION-${subawardId.slice(0, 6).toUpperCase()}` }, approver);
      }
    }
    count++;
    log(`  • ${rec.spec.subrecipientName} — ${rec.note}`);
  }
  return count;
}
