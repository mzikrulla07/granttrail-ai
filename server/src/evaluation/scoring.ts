/**
 * Extraction-accuracy scoring for the labelled evaluation set.
 * Pure functions — unit tested in tests/unit/evaluationScoring.test.ts.
 */
import { FIELD_NAMES, type FieldName, type FieldValues } from '../domain/fields.js';
import { normalizeUei, parseAmount, parseDate } from '../domain/parsing.js';
import type { ExtractedFields } from '../ai/types.js';

export interface LabeledAgreement {
  /** Path relative to the repository root, e.g. tests/evaluation/agreements/rhc-001.pdf */
  file: string;
  /** Ground-truth values as a human reviewer would approve them; null = not present in the agreement */
  expected: FieldValues;
  notes?: string;
}

export interface FieldScore {
  field: FieldName;
  expected: string | null;
  predicted: string | null;
  confidence: number;
  correct: boolean;
  /** Token F1 for free-text fields (1 for exact fields when correct) */
  similarity: number;
}

const DESCRIPTION_MATCH_F1 = 0.8;

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9$.\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

export function tokenF1(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.length === 0 && tb.length === 0) return 1;
  if (ta.length === 0 || tb.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const t of tb) counts.set(t, (counts.get(t) ?? 0) + 1);
  let overlap = 0;
  for (const t of ta) {
    const c = counts.get(t) ?? 0;
    if (c > 0) {
      overlap++;
      counts.set(t, c - 1);
    }
  }
  if (overlap === 0) return 0;
  const p = overlap / ta.length;
  const r = overlap / tb.length;
  return (2 * p * r) / (p + r);
}

/** Canonical form for comparing a field value. */
export function canonical(field: FieldName, v: string | null): string | null {
  if (v === null || v.trim() === '') return null;
  switch (field) {
    case 'uei':
      return normalizeUei(v);
    case 'amount': {
      const a = parseAmount(v);
      return a.valid ? a.normalized! : v.trim();
    }
    case 'awardDate':
      return parseDate(v) ?? v.trim();
    default:
      return tokens(v).join(' ');
  }
}

export function scoreField(field: FieldName, expected: string | null, predicted: string | null, confidence: number): FieldScore {
  const e = canonical(field, expected);
  const p = canonical(field, predicted);
  let correct: boolean;
  let similarity: number;
  if (e === null || p === null) {
    correct = e === p; // both null = correctly reported as absent
    similarity = correct ? 1 : 0;
  } else if (field === 'projectDescription') {
    similarity = tokenF1(p, e);
    correct = similarity >= DESCRIPTION_MATCH_F1;
  } else {
    correct = e === p;
    similarity = correct ? 1 : field === 'uei' || field === 'amount' || field === 'awardDate' ? 0 : tokenF1(p, e);
  }
  return { field, expected, predicted, confidence, correct, similarity };
}

export function scoreAgreement(expected: FieldValues, extracted: ExtractedFields): FieldScore[] {
  return FIELD_NAMES.map((f) => scoreField(f, expected[f], extracted[f].value, extracted[f].confidence));
}

export interface EvaluationSummary {
  agreements: number;
  fieldAccuracy: Record<FieldName, number>;
  overallFieldAccuracy: number;
  fullyCorrectAgreements: number;
  /** Of predictions at/above the confidence threshold, the share that were correct */
  highConfidencePrecision: number | null;
  /** Wrong values the model was confident about — the most dangerous error class */
  confidentErrors: number;
  /** Wrong values correctly flagged by low confidence */
  flaggedErrors: number;
  /** Values invented where the ground truth says the field is absent */
  hallucinations: number;
}

export function summarize(results: FieldScore[][], lowConfidenceThreshold: number): EvaluationSummary {
  const all = results.flat();
  const fieldAccuracy = Object.fromEntries(
    FIELD_NAMES.map((f) => {
      const rows = all.filter((r) => r.field === f);
      return [f, rows.length ? rows.filter((r) => r.correct).length / rows.length : 0];
    }),
  ) as Record<FieldName, number>;
  const high = all.filter((r) => r.predicted !== null && r.confidence >= lowConfidenceThreshold);
  return {
    agreements: results.length,
    fieldAccuracy,
    overallFieldAccuracy: all.length ? all.filter((r) => r.correct).length / all.length : 0,
    fullyCorrectAgreements: results.filter((r) => r.every((x) => x.correct)).length,
    highConfidencePrecision: high.length ? high.filter((r) => r.correct).length / high.length : null,
    confidentErrors: all.filter((r) => !r.correct && r.predicted !== null && r.confidence >= lowConfidenceThreshold).length,
    flaggedErrors: all.filter((r) => !r.correct && (r.predicted === null || r.confidence < lowConfidenceThreshold)).length,
    hallucinations: all.filter((r) => r.expected === null && r.predicted !== null).length,
  };
}
