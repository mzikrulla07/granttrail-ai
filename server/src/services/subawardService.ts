/**
 * Subaward workflow service.
 *
 *   upload → text extraction → AI extraction → deterministic validation
 *   → human review/edit → human approval (blocked on errors) → export → reported
 *
 * Every state change is written to the append-only audit trail inside the same
 * database transaction as the change itself.
 */
import type { AuthUser } from '../auth/index.js';
import type { RulesConfig } from '../config.js';
import type { Db, Queryable } from '../db/index.js';
import {
  cleanValue,
  emptyFieldValues,
  FIELD_LABELS,
  FIELD_NAMES,
  type FieldName,
  type FieldValues,
} from '../domain/fields.js';
import { todayIso } from '../domain/parsing.js';
import {
  assertApprovable,
  validateSubaward,
  type FieldMeta,
  type Timeliness,
  type ValidationReport,
} from '../domain/validation.js';
import { AiExtractionError, type ExtractionResult, type Extractor } from '../ai/types.js';
import { AppError } from '../http/errors.js';
import { extractPdfText, isPdfBuffer, sanitizeFilename, sha256 } from '../pdf/pdf.js';
import type { DocumentStorage } from '../storage/index.js';
import { recordAudit } from './audit.js';
import { buildCsv, type ExportRow } from './csv.js';

export type SubawardStatus = 'awaiting_review' | 'approved' | 'reported';

export const MIN_EXTRACTED_TEXT_CHARS = 40;

export const APPROVAL_ATTESTATION =
  'I have reviewed each field against the source agreement, verified all low-confidence and flagged values, and confirm this record is accurate for federal subaward reporting.';

interface SubawardRow {
  id: string;
  document_id: string;
  status: SubawardStatus;
  subrecipient_name: string | null;
  uei: string | null;
  amount: string | null;
  award_date: string | null;
  place_of_performance: string | null;
  project_description: string | null;
  due_date: string | null;
  validation_status: 'PASS' | 'WARNING' | 'ERROR';
  extraction_mode: 'demo' | 'claude';
  extraction_status: 'completed' | 'failed';
  extraction_model: string | null;
  exported_at: string | Date | null;
  reported_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface FieldRow {
  subaward_id: string;
  field_name: FieldName;
  ai_value: string | null;
  ai_confidence: string | number;
  source_excerpt: string | null;
  current_value: string | null;
  is_human_edited: boolean;
  edited_at: string | Date | null;
  edited_by_name: string | null;
}

export interface FieldDto {
  name: FieldName;
  label: string;
  value: string | null;
  aiValue: string | null;
  confidence: number;
  sourceExcerpt: string | null;
  isHumanEdited: boolean;
  editedAt: string | null;
  editedBy: string | null;
}

export interface SubawardSummaryDto {
  id: string;
  status: SubawardStatus;
  subrecipientName: string | null;
  uei: string | null;
  amount: string | null;
  awardDate: string | null;
  dueDate: string | null;
  daysUntilDue: number | null;
  timeliness: Timeliness;
  validationStatus: 'PASS' | 'WARNING' | 'ERROR';
  errorCount: number;
  warningCount: number;
  extractionMode: 'demo' | 'claude';
  updatedAt: string;
}

export interface SubawardDetailDto extends SubawardSummaryDto {
  fields: FieldDto[];
  validation: ValidationReport;
  extraction: { mode: 'demo' | 'claude'; model: string | null; status: 'completed' | 'failed' };
  document: {
    id: string;
    filename: string;
    sizeBytes: number;
    pageCount: number | null;
    sha256: string;
    uploadedAt: string;
    uploadedBy: string;
    text: string;
  };
  approval: null | { approvedBy: string; approvedAt: string; attestation: string; validationStatus: string };
  exportedAt: string | null;
  reportedAt: string | null;
  createdAt: string;
  attestationText: string;
}

export type ListFilter = 'all' | 'due_soon' | 'overdue' | 'awaiting_review' | 'approved' | 'reported';

export interface ServiceDeps {
  db: Db;
  storage: DocumentStorage;
  extractor: Extractor;
  rules: RulesConfig;
  exportConfig: { primeAwardeeName: string; primeAwardId: string };
  /** Injectable clock for deterministic tests */
  today?: () => string;
}

const iso = (v: string | Date | null): string | null =>
  v === null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString();

export class SubawardService {
  constructor(private readonly deps: ServiceDeps) {}

  private today(): string {
    return this.deps.today ? this.deps.today() : todayIso();
  }

  private validate(values: FieldValues, meta: Partial<Record<FieldName, FieldMeta>>, status: SubawardStatus) {
    return validateSubaward({ values, meta, status, today: this.today(), rules: this.deps.rules });
  }

  // ------------------------------------------------------------------ upload

  async ingestDocument(input: {
    buffer: Buffer;
    originalName?: string;
    user: AuthUser;
  }): Promise<{ subawardId: string; extraction: ExtractionResult | null }> {
    const { buffer, user } = input;
    if (!buffer?.length) throw new AppError(400, 'EMPTY_FILE', 'The uploaded file is empty.');
    if (!isPdfBuffer(buffer)) {
      throw new AppError(415, 'NOT_A_PDF', 'Only PDF files can be uploaded. The selected file is not a valid PDF.');
    }
    const hash = sha256(buffer);
    const dup = await this.deps.db.query<{ subaward_id: string }>(
      `SELECT s.id AS subaward_id FROM documents d JOIN subawards s ON s.document_id = d.id WHERE d.sha256 = $1`,
      [hash],
    );
    if (dup.rows[0]) {
      throw new AppError(409, 'DUPLICATE_DOCUMENT', 'This agreement has already been uploaded.', {
        subawardId: dup.rows[0].subaward_id,
      });
    }

    const { text, pageCount } = await extractPdfText(buffer);
    if (text.replace(/\s/g, '').length < MIN_EXTRACTED_TEXT_CHARS) {
      throw new AppError(
        422,
        'NO_TEXT',
        'No readable text was found in this PDF. It may be a scanned image — scanned agreements need OCR, which this MVP does not yet support.',
      );
    }

    const filename = sanitizeFilename(input.originalName);
    const storageKey = await this.deps.storage.put(buffer, 'application/pdf');

    // AI extraction happens outside the DB transaction (it can take seconds).
    let extraction: ExtractionResult | null = null;
    let failureReason: string | null = null;
    let failureDiagnostic: Record<string, unknown> | undefined;
    try {
      extraction = await this.deps.extractor.extract(text);
    } catch (err) {
      failureReason = err instanceof AiExtractionError ? err.reason : 'unexpected';
      failureDiagnostic = err instanceof AiExtractionError ? err.diagnostic : undefined;
      console.error('[extraction] failed:', err instanceof Error ? err.message : err);
    }

    const values = emptyFieldValues();
    const meta: Partial<Record<FieldName, FieldMeta>> = {};
    for (const f of FIELD_NAMES) {
      values[f] = extraction?.fields[f].value ?? null;
      meta[f] = { confidence: extraction?.fields[f].confidence ?? 0, humanEdited: false };
    }
    const report = this.validate(values, meta, 'awaiting_review');

    const subawardId = await this.deps.db.transaction(async (tx) => {
      const doc = await tx.query<{ id: string }>(
        `INSERT INTO documents (original_filename, storage_driver, storage_key, mime_type, size_bytes, sha256, page_count, extracted_text, uploaded_by)
         VALUES ($1, $2, $3, 'application/pdf', $4, $5, $6, $7, $8) RETURNING id`,
        [filename, this.deps.storage.driver, storageKey, buffer.length, hash, pageCount, text, user.id],
      );
      const n = report.normalized;
      const sub = await tx.query<{ id: string }>(
        `INSERT INTO subawards (document_id, status, subrecipient_name, uei, amount, award_date, place_of_performance,
                                project_description, due_date, validation_status, validation_results, last_validated_at,
                                extraction_mode, extraction_status, extraction_model, created_by)
         VALUES ($1, 'awaiting_review', $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, now(), $11, $12, $13, $14) RETURNING id`,
        [
          doc.rows[0]!.id,
          values.subrecipientName,
          n.uei ?? values.uei,
          n.amount,
          n.awardDate,
          values.placeOfPerformance,
          values.projectDescription,
          report.dueDate,
          report.status,
          JSON.stringify(report.checks),
          this.deps.extractor.mode,
          extraction ? 'completed' : 'failed',
          this.deps.extractor.model,
          user.id,
        ],
      );
      const id = sub.rows[0]!.id;

      for (const f of FIELD_NAMES) {
        const ef = extraction?.fields[f];
        await tx.query(
          `INSERT INTO extracted_fields (subaward_id, field_name, ai_value, ai_confidence, source_excerpt, current_value)
           VALUES ($1, $2, $3, $4, $5, $3)`,
          [id, f, ef?.value ?? null, ef?.confidence ?? 0, ef?.sourceExcerpt ?? null],
        );
      }

      await recordAudit(tx, {
        subawardId: id,
        type: 'document_uploaded',
        actor: user,
        details: { filename, sizeBytes: buffer.length, pageCount, sha256: hash, storage: this.deps.storage.driver },
      });
      if (extraction) {
        await recordAudit(tx, {
          subawardId: id,
          type: 'ai_extraction_completed',
          actor: 'system',
          details: {
            mode: extraction.mode,
            model: extraction.model,
            fields: Object.fromEntries(
              FIELD_NAMES.map((f) => [f, { value: extraction!.fields[f].value, confidence: extraction!.fields[f].confidence }]),
            ),
            notes: extraction.notes,
          },
        });
      } else {
        await recordAudit(tx, {
          subawardId: id,
          type: 'ai_extraction_failed',
          actor: 'system',
          details: {
            mode: this.deps.extractor.mode,
            reason: failureReason,
            ...(failureDiagnostic ?? {}),
            action: 'All fields require manual entry.',
          },
        });
      }
      await recordAudit(tx, {
        subawardId: id,
        type: 'validation_performed',
        actor: 'system',
        details: validationSummary(report, 'initial_extraction'),
      });
      return id;
    });

    return { subawardId, extraction };
  }

  // ------------------------------------------------------------------ reads

  private async loadFields(q: Queryable, ids: string[]): Promise<Map<string, FieldRow[]>> {
    const map = new Map<string, FieldRow[]>();
    if (ids.length === 0) return map;
    const { rows } = await q.query<FieldRow>(
      `SELECT ef.subaward_id, ef.field_name, ef.ai_value, ef.ai_confidence, ef.source_excerpt, ef.current_value,
              ef.is_human_edited, ef.edited_at, u.full_name AS edited_by_name
         FROM extracted_fields ef LEFT JOIN users u ON u.id = ef.edited_by
        WHERE ef.subaward_id = ANY($1::uuid[])`,
      [ids],
    );
    for (const r of rows) {
      const list = map.get(r.subaward_id) ?? [];
      list.push(r);
      map.set(r.subaward_id, list);
    }
    return map;
  }

  private valuesAndMeta(fields: FieldRow[]) {
    const values = emptyFieldValues();
    const meta: Partial<Record<FieldName, FieldMeta>> = {};
    for (const r of fields) {
      values[r.field_name] = r.current_value;
      meta[r.field_name] = { confidence: Number(r.ai_confidence), humanEdited: r.is_human_edited };
    }
    return { values, meta };
  }

  private summarize(row: SubawardRow, report: ValidationReport): SubawardSummaryDto {
    return {
      id: row.id,
      status: row.status,
      subrecipientName: row.subrecipient_name,
      uei: row.uei,
      amount: row.amount,
      awardDate: row.award_date,
      dueDate: report.dueDate ?? row.due_date,
      daysUntilDue: report.daysUntilDue,
      timeliness: report.timeliness,
      validationStatus: report.status,
      errorCount: report.blockingErrorCount,
      warningCount: report.warningCount,
      extractionMode: row.extraction_mode,
      updatedAt: iso(row.updated_at)!,
    };
  }

  async list(filter: ListFilter = 'all', search?: string): Promise<SubawardSummaryDto[]> {
    const { rows } = await this.deps.db.query<SubawardRow>(
      `SELECT * FROM subawards ORDER BY due_date ASC NULLS FIRST, created_at DESC`,
    );
    const fieldMap = await this.loadFields(this.deps.db, rows.map((r) => r.id));
    let items = rows.map((row) => {
      const { values, meta } = this.valuesAndMeta(fieldMap.get(row.id) ?? []);
      return this.summarize(row, this.validate(values, meta, row.status));
    });
    items = items.filter((s) => matchesFilter(s, filter));
    const term = search?.trim().toLowerCase();
    if (term) {
      items = items.filter(
        (s) => (s.subrecipientName ?? '').toLowerCase().includes(term) || (s.uei ?? '').toLowerCase().includes(term),
      );
    }
    return items;
  }

  async dashboard() {
    const all = await this.list('all');
    const upcoming = all
      .filter((s) => s.status !== 'reported')
      .sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999'));
    return {
      totals: {
        total: all.length,
        dueSoon: all.filter((s) => matchesFilter(s, 'due_soon')).length,
        overdue: all.filter((s) => matchesFilter(s, 'overdue')).length,
        awaitingReview: all.filter((s) => s.status === 'awaiting_review').length,
        approved: all.filter((s) => s.status === 'approved').length,
        reported: all.filter((s) => s.status === 'reported').length,
        approvedOrReported: all.filter((s) => s.status === 'approved' || s.status === 'reported').length,
        totalAmount: all.reduce((sum, s) => sum + (s.amount ? Number(s.amount) : 0), 0).toFixed(2),
        withErrors: all.filter((s) => s.validationStatus === 'ERROR').length,
      },
      nextDeadline: upcoming[0]?.dueDate ?? null,
      rules: this.deps.rules,
    };
  }

  async get(id: string, q: Queryable = this.deps.db): Promise<SubawardDetailDto> {
    const { rows } = await q.query<
      SubawardRow & {
        doc_filename: string;
        doc_size: number;
        doc_pages: number | null;
        doc_sha: string;
        doc_created: string | Date;
        doc_text: string;
        uploader: string;
      }
    >(
      `SELECT s.*, d.original_filename AS doc_filename, d.size_bytes AS doc_size, d.page_count AS doc_pages,
              d.sha256 AS doc_sha, d.created_at AS doc_created, d.extracted_text AS doc_text, u.full_name AS uploader
         FROM subawards s JOIN documents d ON d.id = s.document_id JOIN users u ON u.id = d.uploaded_by
        WHERE s.id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Subaward not found.');

    const fieldRows = (await this.loadFields(q, [id])).get(id) ?? [];
    const { values, meta } = this.valuesAndMeta(fieldRows);
    const report = this.validate(values, meta, row.status);

    const approvalRes = await q.query<{
      full_name: string;
      approved_at: string | Date;
      attestation: string;
      validation_status_at_approval: string;
    }>(
      `SELECT u.full_name, a.approved_at, a.attestation, a.validation_status_at_approval
         FROM approvals a JOIN users u ON u.id = a.approved_by WHERE a.subaward_id = $1`,
      [id],
    );
    const a = approvalRes.rows[0];

    const byName = new Map(fieldRows.map((r) => [r.field_name, r]));
    return {
      ...this.summarize(row, report),
      fields: FIELD_NAMES.map((f) => {
        const r = byName.get(f);
        return {
          name: f,
          label: FIELD_LABELS[f],
          value: r?.current_value ?? null,
          aiValue: r?.ai_value ?? null,
          confidence: r ? Number(r.ai_confidence) : 0,
          sourceExcerpt: r?.source_excerpt ?? null,
          isHumanEdited: r?.is_human_edited ?? false,
          editedAt: iso(r?.edited_at ?? null),
          editedBy: r?.edited_by_name ?? null,
        };
      }),
      validation: report,
      extraction: { mode: row.extraction_mode, model: row.extraction_model, status: row.extraction_status },
      document: {
        id: row.document_id,
        filename: row.doc_filename,
        sizeBytes: row.doc_size,
        pageCount: row.doc_pages,
        sha256: row.doc_sha,
        uploadedAt: iso(row.doc_created)!,
        uploadedBy: row.uploader,
        text: row.doc_text,
      },
      approval: a
        ? {
            approvedBy: a.full_name,
            approvedAt: iso(a.approved_at)!,
            attestation: a.attestation,
            validationStatus: a.validation_status_at_approval,
          }
        : null,
      exportedAt: iso(row.exported_at),
      reportedAt: iso(row.reported_at),
      createdAt: iso(row.created_at)!,
      attestationText: APPROVAL_ATTESTATION,
    };
  }

  /** Validate proposed (unsaved) values — used for live feedback while editing. */
  async previewValidation(id: string, patch: Partial<Record<FieldName, string | null>>): Promise<ValidationReport> {
    const detail = await this.get(id);
    const values = emptyFieldValues();
    const meta: Partial<Record<FieldName, FieldMeta>> = {};
    for (const f of detail.fields) {
      const edited = Object.prototype.hasOwnProperty.call(patch, f.name) && cleanValue(patch[f.name]) !== f.value;
      values[f.name] = edited ? cleanValue(patch[f.name]) : f.value;
      meta[f.name] = { confidence: f.confidence, humanEdited: f.isHumanEdited || edited };
    }
    return this.validate(values, meta, detail.status);
  }

  // ------------------------------------------------------------------ writes

  private async lockRow(tx: Queryable, id: string): Promise<SubawardRow> {
    const { rows } = await tx.query<SubawardRow>('SELECT * FROM subawards WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) throw new AppError(404, 'NOT_FOUND', 'Subaward not found.');
    return rows[0];
  }

  /** Apply reviewer edits; each change is audited with before/after values. Returns number of fields changed. */
  private async applyEdits(
    tx: Queryable,
    row: SubawardRow,
    patch: Partial<Record<FieldName, string | null>>,
    user: AuthUser,
  ): Promise<{ changed: number; report: ValidationReport }> {
    if (row.status !== 'awaiting_review') {
      throw new AppError(409, 'RECORD_LOCKED', 'This record has been approved and can no longer be edited.');
    }
    const fieldRows = (await this.loadFields(tx, [row.id])).get(row.id) ?? [];
    let changed = 0;
    for (const r of fieldRows) {
      if (!Object.prototype.hasOwnProperty.call(patch, r.field_name)) continue;
      const next = cleanValue(patch[r.field_name]);
      if (next === r.current_value) continue;
      await tx.query(
        `UPDATE extracted_fields SET current_value = $1, is_human_edited = true, edited_by = $2, edited_at = now()
          WHERE subaward_id = $3 AND field_name = $4`,
        [next, user.id, row.id, r.field_name],
      );
      await recordAudit(tx, {
        subawardId: row.id,
        type: 'field_edited',
        actor: user,
        details: {
          field: r.field_name,
          label: FIELD_LABELS[r.field_name],
          previousValue: r.current_value,
          newValue: next,
          originalAiValue: r.ai_value,
          originalAiConfidence: Number(r.ai_confidence),
        },
      });
      r.current_value = next;
      r.is_human_edited = true;
      changed++;
    }
    const { values, meta } = this.valuesAndMeta(fieldRows);
    const report = this.validate(values, meta, row.status);
    if (changed > 0) {
      const n = report.normalized;
      await tx.query(
        `UPDATE subawards SET subrecipient_name = $1, uei = $2, amount = $3, award_date = $4, place_of_performance = $5,
                              project_description = $6, due_date = $7, validation_status = $8, validation_results = $9::jsonb,
                              last_validated_at = now()
          WHERE id = $10`,
        [
          values.subrecipientName,
          n.uei ?? values.uei,
          n.amount,
          n.awardDate,
          values.placeOfPerformance,
          values.projectDescription,
          report.dueDate,
          report.status,
          JSON.stringify(report.checks),
          row.id,
        ],
      );
    }
    return { changed, report };
  }

  async saveDraft(id: string, patch: Partial<Record<FieldName, string | null>>, user: AuthUser) {
    await this.deps.db.transaction(async (tx) => {
      const row = await this.lockRow(tx, id);
      const { changed, report } = await this.applyEdits(tx, row, patch, user);
      if (changed > 0) {
        await recordAudit(tx, {
          subawardId: id,
          type: 'validation_performed',
          actor: user,
          details: { ...validationSummary(report, 'save_draft'), fieldsChanged: changed },
        });
      }
    });
    return this.get(id);
  }

  async revalidate(id: string, user: AuthUser) {
    await this.deps.db.transaction(async (tx) => {
      const row = await this.lockRow(tx, id);
      const fieldRows = (await this.loadFields(tx, [id])).get(id) ?? [];
      const { values, meta } = this.valuesAndMeta(fieldRows);
      const report = this.validate(values, meta, row.status);
      await tx.query(
        `UPDATE subawards SET validation_status = $1, validation_results = $2::jsonb, last_validated_at = now() WHERE id = $3`,
        [report.status, JSON.stringify(report.checks), id],
      );
      await recordAudit(tx, { subawardId: id, type: 'validation_performed', actor: user, details: validationSummary(report, 'manual') });
    });
    return this.get(id);
  }

  async approve(
    id: string,
    input: { attestation: boolean; fields?: Partial<Record<FieldName, string | null>> },
    user: AuthUser,
  ) {
    if (input.attestation !== true) {
      throw new AppError(400, 'ATTESTATION_REQUIRED', 'Confirm the reviewer attestation before approving.');
    }
    await this.deps.db.transaction(async (tx) => {
      const row = await this.lockRow(tx, id);
      if (row.status !== 'awaiting_review') {
        throw new AppError(409, 'ALREADY_APPROVED', 'This record has already been approved.');
      }
      const { report } = await this.applyEdits(tx, row, input.fields ?? {}, user);
      await recordAudit(tx, { subawardId: id, type: 'validation_performed', actor: user, details: validationSummary(report, 'approval') });

      // Deterministic approval gate — the AI plays no part in this decision.
      const gate = assertApprovable(report);
      if (!gate.allowed) {
        throw new AppError(422, 'APPROVAL_BLOCKED', 'This record cannot be approved until all blocking validation errors are resolved.', {
          reasons: gate.reasons,
        });
      }

      const fieldRows = (await this.loadFields(tx, [id])).get(id) ?? [];
      const n = report.normalized;
      const snapshot = {
        values: n,
        dueDate: report.dueDate,
        reportingRequired: report.reportingRequired,
        fields: fieldRows.map((r) => ({
          field: r.field_name,
          approvedValue: r.current_value,
          originalAiValue: r.ai_value,
          aiConfidence: Number(r.ai_confidence),
          sourceExcerpt: r.source_excerpt,
          humanEdited: r.is_human_edited,
        })),
        validation: report.checks,
      };

      // Link / create the partner agency record by UEI.
      let partnerId: string | null = null;
      if (n.uei) {
        const existing = await tx.query<{ id: string }>('SELECT id FROM partner_agencies WHERE uei = $1', [n.uei]);
        if (existing.rows[0]) {
          partnerId = existing.rows[0].id;
        } else {
          const stateMatch = /,\s*([A-Z]{2})\s+\d{5}/.exec(n.placeOfPerformance ?? '');
          const created = await tx.query<{ id: string }>(
            'INSERT INTO partner_agencies (name, uei, state) VALUES ($1, $2, $3) RETURNING id',
            [n.subrecipientName, n.uei, stateMatch?.[1] ?? null],
          );
          partnerId = created.rows[0]!.id;
        }
      }

      await tx.query(
        `INSERT INTO approvals (subaward_id, approved_by, attestation, validation_status_at_approval, snapshot)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [id, user.id, APPROVAL_ATTESTATION, report.status, JSON.stringify(snapshot)],
      );
      await tx.query(
        `UPDATE subawards SET status = 'approved', partner_agency_id = $2, validation_status = $3,
                              validation_results = $4::jsonb, last_validated_at = now()
          WHERE id = $1`,
        [id, partnerId, report.status, JSON.stringify(report.checks)],
      );
      await recordAudit(tx, {
        subawardId: id,
        type: 'record_approved',
        actor: user,
        details: {
          validationStatus: report.status,
          warningsAcknowledged: report.checks.filter((c) => c.severity === 'WARNING').map((c) => c.message),
          attestation: APPROVAL_ATTESTATION,
        },
      });
      await recordAudit(tx, {
        subawardId: id,
        type: 'status_changed',
        actor: user,
        details: { from: 'awaiting_review', to: 'approved' },
      });
    });
    return this.get(id);
  }

  async markReported(id: string, input: { reference?: string }, user: AuthUser) {
    await this.deps.db.transaction(async (tx) => {
      const row = await this.lockRow(tx, id);
      if (row.status !== 'approved') {
        throw new AppError(
          409,
          'INVALID_STATUS',
          row.status === 'reported'
            ? 'This record is already marked as reported.'
            : 'Only approved records can be marked as reported.',
        );
      }
      await tx.query(`UPDATE subawards SET status = 'reported', reported_at = now() WHERE id = $1`, [id]);
      await recordAudit(tx, {
        subawardId: id,
        type: 'status_changed',
        actor: user,
        details: { from: 'approved', to: 'reported', submissionReference: input.reference ?? null },
      });
    });
    return this.get(id);
  }

  // ------------------------------------------------------------------ export

  async exportCsv(ids: string[] | 'all_approved', user: AuthUser): Promise<{ filename: string; csv: string; count: number }> {
    return this.deps.db.transaction(async (tx) => {
      const { rows } = await tx.query<
        SubawardRow & { approver: string; approved_at: string | Date }
      >(
        ids === 'all_approved'
          ? `SELECT s.*, u.full_name AS approver, a.approved_at FROM subawards s
               JOIN approvals a ON a.subaward_id = s.id JOIN users u ON u.id = a.approved_by
              WHERE s.status = 'approved' ORDER BY s.award_date`
          : `SELECT s.*, u.full_name AS approver, a.approved_at FROM subawards s
               LEFT JOIN approvals a ON a.subaward_id = s.id LEFT JOIN users u ON u.id = a.approved_by
              WHERE s.id = ANY($1::uuid[]) ORDER BY s.award_date`,
        ids === 'all_approved' ? [] : [ids],
      );
      if (ids !== 'all_approved' && rows.length !== ids.length) {
        throw new AppError(404, 'NOT_FOUND', 'Subaward not found.');
      }
      if (rows.length === 0) {
        throw new AppError(409, 'NOTHING_TO_EXPORT', 'There are no approved records waiting to be exported.');
      }
      const notApproved = rows.filter((r) => r.status === 'awaiting_review');
      if (notApproved.length > 0) {
        throw new AppError(409, 'NOT_APPROVED', 'Only approved records can be exported. Complete review and approval first.');
      }

      const exportRows: ExportRow[] = rows.map((r) => ({
        primeAwardId: this.deps.exportConfig.primeAwardId,
        primeAwardeeName: this.deps.exportConfig.primeAwardeeName,
        subrecipientName: r.subrecipient_name ?? '',
        subrecipientUei: r.uei ?? '',
        subawardAmount: r.amount ?? '',
        subawardDate: r.award_date ?? '',
        placeOfPerformance: r.place_of_performance ?? '',
        subawardDescription: r.project_description ?? '',
        reportingDueDate: r.due_date ?? '',
        approvedBy: r.approver,
        approvedAt: iso(r.approved_at) ?? '',
        recordId: r.id,
      }));
      const csv = buildCsv(exportRows);
      const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
      const filename =
        rows.length === 1
          ? `granttrail-subaward-${rows[0]!.id.slice(0, 8)}-${stamp}.csv`
          : `granttrail-subawards-${rows.length}-${stamp}.csv`;

      for (const r of rows) {
        await tx.query('UPDATE subawards SET exported_at = now() WHERE id = $1', [r.id]);
        await recordAudit(tx, {
          subawardId: r.id,
          type: 'export_generated',
          actor: user,
          details: { format: 'SAM.gov-ready CSV', filename, recordsInFile: rows.length },
        });
      }
      return { filename, csv, count: rows.length };
    });
  }

  async getDocumentFile(subawardId: string): Promise<{ buffer: Buffer; filename: string }> {
    const { rows } = await this.deps.db.query<{ storage_key: string; original_filename: string; storage_driver: string }>(
      `SELECT d.storage_key, d.original_filename, d.storage_driver
         FROM subawards s JOIN documents d ON d.id = s.document_id WHERE s.id = $1`,
      [subawardId],
    );
    const r = rows[0];
    if (!r) throw new AppError(404, 'NOT_FOUND', 'Document not found.');
    try {
      return { buffer: await this.deps.storage.get(r.storage_key), filename: r.original_filename };
    } catch {
      throw new AppError(404, 'FILE_UNAVAILABLE', 'The original PDF is not available in document storage.');
    }
  }
}

export function matchesFilter(s: SubawardSummaryDto, filter: ListFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'due_soon':
      return s.status !== 'reported' && s.timeliness === 'due_soon';
    case 'overdue':
      return s.status !== 'reported' && s.timeliness === 'overdue';
    case 'awaiting_review':
      return s.status === 'awaiting_review';
    case 'approved':
      return s.status === 'approved';
    case 'reported':
      return s.status === 'reported';
  }
}

function validationSummary(report: ValidationReport, trigger: string) {
  return {
    trigger,
    result: report.status,
    blockingErrors: report.blockingErrorCount,
    warnings: report.warningCount,
    issues: report.checks.filter((c) => c.severity !== 'PASS').map((c) => ({ code: c.code, field: c.field, severity: c.severity, message: c.message })),
    dueDate: report.dueDate,
  };
}
