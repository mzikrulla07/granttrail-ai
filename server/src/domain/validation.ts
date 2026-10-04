/**
 * Deterministic validation engine.
 *
 *   AI extracts.  CODE VALIDATES.  Humans approve.
 *
 * Every compliance rule lives here as plain TypeScript. The AI model is never
 * asked whether a record is compliant, and nothing here calls a model. Given
 * the same inputs and the same `today`, the output is always identical.
 */
import { DEFAULT_RULES, type RulesConfig } from '../config.js';
import { FIELD_LABELS, FIELD_NAMES, type FieldName, type FieldValues } from './fields.js';
import {
  calculateReportingDueDate,
  checkUei,
  daysBetween,
  formatLongDate,
  formatUsd,
  parseAmount,
  parseDate,
  todayIso,
} from './parsing.js';

export type Severity = 'PASS' | 'WARNING' | 'ERROR';

export interface ValidationCheck {
  /** Stable machine code, e.g. UEI_FORMAT */
  code: string;
  /** Field the check applies to, or null for record-level checks */
  field: FieldName | null;
  severity: Severity;
  /** Human-readable explanation shown to the reviewer */
  message: string;
  /** ERROR checks block approval */
  blocking: boolean;
}

export type Timeliness = 'on_track' | 'due_soon' | 'overdue' | 'reported' | 'unknown';

export interface FieldMeta {
  confidence: number;
  humanEdited: boolean;
}

export interface ValidationInput {
  values: FieldValues;
  /** AI confidence per field; absent for manual records */
  meta?: Partial<Record<FieldName, FieldMeta>>;
  status?: 'awaiting_review' | 'approved' | 'reported';
  today?: string;
  rules?: RulesConfig;
}

export interface NormalizedValues {
  subrecipientName: string | null;
  uei: string | null;
  amount: string | null;
  awardDate: string | null;
  placeOfPerformance: string | null;
  projectDescription: string | null;
}

export interface ValidationReport {
  status: Severity;
  checks: ValidationCheck[];
  fieldStatus: Record<FieldName, Severity>;
  normalized: NormalizedValues;
  dueDate: string | null;
  daysUntilDue: number | null;
  timeliness: Timeliness;
  reportingRequired: boolean | null;
  blockingErrorCount: number;
  warningCount: number;
  canApprove: boolean;
}

const RANK: Record<Severity, number> = { PASS: 0, WARNING: 1, ERROR: 2 };

export function worst(a: Severity, b: Severity): Severity {
  return RANK[a] >= RANK[b] ? a : b;
}

export function validateSubaward(input: ValidationInput): ValidationReport {
  const rules = input.rules ?? DEFAULT_RULES;
  const today = input.today ?? todayIso();
  const v = input.values;
  const checks: ValidationCheck[] = [];
  const normalized: NormalizedValues = {
    subrecipientName: null,
    uei: null,
    amount: null,
    awardDate: null,
    placeOfPerformance: null,
    projectDescription: null,
  };

  const add = (code: string, field: FieldName | null, severity: Severity, message: string) =>
    checks.push({ code, field, severity, message, blocking: severity === 'ERROR' });

  // ---- Required fields -------------------------------------------------
  for (const f of FIELD_NAMES) {
    if (v[f] === null || v[f] === undefined || String(v[f]).trim() === '') {
      add(
        'REQUIRED_FIELD',
        f,
        'ERROR',
        `${FIELD_LABELS[f]} is required for subaward reporting but was not found. Locate it in the agreement and enter it manually.`,
      );
    }
  }
  const has = (f: FieldName) => typeof v[f] === 'string' && v[f]!.trim() !== '';

  // ---- Subrecipient name ------------------------------------------------
  if (has('subrecipientName')) {
    const name = v.subrecipientName!.trim();
    if (name.length < 3 || name.length > 200) {
      add('NAME_LENGTH', 'subrecipientName', 'ERROR', 'Subrecipient name must be between 3 and 200 characters.');
    } else {
      normalized.subrecipientName = name;
      add('NAME_PRESENT', 'subrecipientName', 'PASS', 'Subrecipient name is present.');
    }
  }

  // ---- UEI format -------------------------------------------------------
  if (has('uei')) {
    const r = checkUei(v.uei!);
    if (r.valid) {
      normalized.uei = r.normalized;
      add('UEI_FORMAT', 'uei', 'PASS', `UEI ${r.normalized} matches the SAM.gov 12-character format.`);
    } else {
      add('UEI_FORMAT', 'uei', 'ERROR', `UEI "${v.uei}" is not valid. ${r.problem}`);
    }
  }

  // ---- Monetary amount + reporting threshold --------------------------------
  let reportingRequired: boolean | null = null;
  if (has('amount')) {
    const r = parseAmount(v.amount!);
    if (!r.valid) {
      add('AMOUNT_FORMAT', 'amount', 'ERROR', `Amount "${v.amount}" is not a valid monetary amount. ${r.problem}`);
    } else {
      normalized.amount = r.normalized!;
      add('AMOUNT_FORMAT', 'amount', 'PASS', `Amount ${formatUsd(r.value!)} is a valid monetary value.`);
      reportingRequired = r.value! >= rules.reportingThreshold;
      if (reportingRequired) {
        add(
          'REPORTING_THRESHOLD',
          'amount',
          'PASS',
          `${formatUsd(r.value!)} meets the ${formatUsd(rules.reportingThreshold)} federal reporting threshold, so this subaward must be reported.`,
        );
      } else {
        add(
          'REPORTING_THRESHOLD',
          'amount',
          'WARNING',
          `${formatUsd(r.value!)} is below the ${formatUsd(rules.reportingThreshold)} reporting threshold. A federal subaward report is generally not required — confirm cumulative obligations to this subrecipient before exporting.`,
        );
      }
    }
  }

  // ---- Award date, due date, overdue ------------------------------------------
  let dueDate: string | null = null;
  let daysUntilDue: number | null = null;
  let timeliness: Timeliness = 'unknown';
  if (has('awardDate')) {
    const iso = parseDate(v.awardDate!);
    if (!iso) {
      add(
        'AWARD_DATE_FORMAT',
        'awardDate',
        'ERROR',
        `Award date "${v.awardDate}" is not a valid calendar date. Use a format such as 2026-08-14 or August 14, 2026.`,
      );
    } else if (iso > today) {
      add(
        'AWARD_DATE_FUTURE',
        'awardDate',
        'ERROR',
        `Award date ${formatLongDate(iso)} is in the future. Subawards are reported after they are made — check the agreement's execution date.`,
      );
    } else {
      normalized.awardDate = iso;
      const ageDays = daysBetween(iso, today);
      if (ageDays > 3 * 365) {
        add(
          'AWARD_DATE_AGE',
          'awardDate',
          'WARNING',
          `Award date ${formatLongDate(iso)} is more than three years old. Confirm this is the correct execution date.`,
        );
      } else {
        add('AWARD_DATE_FORMAT', 'awardDate', 'PASS', `Award date ${formatLongDate(iso)} is a valid date.`);
      }

      dueDate = calculateReportingDueDate(iso);
      daysUntilDue = daysBetween(today, dueDate);
      add(
        'DUE_DATE',
        null,
        'PASS',
        `Report due ${formatLongDate(dueDate)} — the end of the month following the award month.`,
      );

      if (input.status === 'reported') {
        timeliness = 'reported';
        add('TIMELINESS', null, 'PASS', 'This subaward has been reported.');
      } else if (daysUntilDue < 0) {
        timeliness = 'overdue';
        add(
          'TIMELINESS',
          null,
          'WARNING',
          `Reporting is OVERDUE by ${-daysUntilDue} day${daysUntilDue === -1 ? '' : 's'} (due ${formatLongDate(dueDate)}). Complete review and report immediately.`,
        );
      } else if (daysUntilDue <= rules.dueSoonDays) {
        timeliness = 'due_soon';
        add(
          'TIMELINESS',
          null,
          'WARNING',
          daysUntilDue === 0
            ? 'Report is due TODAY.'
            : `Report is due in ${daysUntilDue} day${daysUntilDue === 1 ? '' : 's'}.`,
        );
      } else {
        timeliness = 'on_track';
        add('TIMELINESS', null, 'PASS', `On track — ${daysUntilDue} days until the reporting deadline.`);
      }
    }
  }

  // ---- Place of performance ----------------------------------------------
  if (has('placeOfPerformance')) {
    const p = v.placeOfPerformance!.trim();
    normalized.placeOfPerformance = p;
    const hasStateZip = /\b[A-Z]{2}\s+\d{5}(-\d{4})?\b/.test(p);
    if (hasStateZip) {
      add('PLACE_FORMAT', 'placeOfPerformance', 'PASS', 'Place of performance includes a state and ZIP code.');
    } else {
      add(
        'PLACE_FORMAT',
        'placeOfPerformance',
        'WARNING',
        'Place of performance should include city, two-letter state, and 5-digit ZIP code (e.g. "Riverbend, OH 45101").',
      );
    }
  }

  // ---- Project description ----------------------------------------------
  if (has('projectDescription')) {
    const d = v.projectDescription!.trim();
    normalized.projectDescription = d;
    if (d.length < 20) {
      add(
        'DESCRIPTION_LENGTH',
        'projectDescription',
        'WARNING',
        'Project description is very brief. Reports should describe the purpose of the subaward in plain language.',
      );
    } else if (d.length > 4000) {
      add(
        'DESCRIPTION_LENGTH',
        'projectDescription',
        'ERROR',
        `Project description is ${d.length} characters; the reporting limit is 4,000. Summarise the purpose.`,
      );
    } else {
      add('DESCRIPTION_LENGTH', 'projectDescription', 'PASS', 'Project description is present and within length limits.');
    }
  }

  // ---- Low-confidence AI extraction -------------------------------------------
  for (const f of FIELD_NAMES) {
    const m = input.meta?.[f];
    if (!m || m.humanEdited || !has(f)) continue;
    if (m.confidence < rules.lowConfidenceThreshold) {
      add(
        'LOW_CONFIDENCE',
        f,
        'WARNING',
        `AI confidence is ${Math.round(m.confidence * 100)}%, below the ${Math.round(
          rules.lowConfidenceThreshold * 100,
        )}% review threshold. Verify this value against the source excerpt before approving.`,
      );
    }
  }

  // ---- Roll-up -----------------------------------------------------------------
  const fieldStatus = Object.fromEntries(FIELD_NAMES.map((f) => [f, 'PASS' as Severity])) as Record<
    FieldName,
    Severity
  >;
  let status: Severity = 'PASS';
  for (const c of checks) {
    status = worst(status, c.severity);
    if (c.field) fieldStatus[c.field] = worst(fieldStatus[c.field], c.severity);
  }
  const blockingErrorCount = checks.filter((c) => c.blocking).length;
  const warningCount = checks.filter((c) => c.severity === 'WARNING').length;

  return {
    status,
    checks,
    fieldStatus,
    normalized,
    dueDate,
    daysUntilDue,
    timeliness,
    reportingRequired,
    blockingErrorCount,
    warningCount,
    canApprove: blockingErrorCount === 0,
  };
}

/**
 * Approval gate. Deterministic: approval is refused while any blocking
 * (ERROR) check remains. Returns the reasons so the UI/API can explain.
 */
export function assertApprovable(report: ValidationReport): { allowed: boolean; reasons: string[] } {
  const reasons = report.checks.filter((c) => c.blocking).map((c) => c.message);
  return { allowed: reasons.length === 0, reasons };
}
