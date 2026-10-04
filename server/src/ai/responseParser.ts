/**
 * Parsing and grounding of model output.
 *
 * The model's answer is treated as untrusted input:
 *   1. It must match a strict schema (zod) or it is rejected.
 *   2. Values are cleaned; missing values become null with low confidence.
 *   3. Every source excerpt is checked against the actual document text. An
 *      excerpt that cannot be found is treated as a possible hallucination and
 *      the field's confidence is capped so a human must verify it.
 */
import { z } from 'zod';
import { cleanValue, FIELD_LABELS, FIELD_NAMES, type FieldName } from '../domain/fields.js';
import { AiExtractionError, type ExtractedField, type ExtractedFields } from './types.js';

export const MISSING_VALUE_MAX_CONFIDENCE = 0.1;
export const UNGROUNDED_MAX_CONFIDENCE = 0.4;
export const NO_EXCERPT_MAX_CONFIDENCE = 0.5;

const RawField = z
  .object({
    value: z.union([z.string(), z.number(), z.null()]).optional(),
    confidence: z.union([z.number(), z.string()]).optional(),
    sourceExcerpt: z.union([z.string(), z.null()]).optional(),
  })
  .loose();

const RawResponse = z.object(
  Object.fromEntries(FIELD_NAMES.map((f) => [f, RawField.nullable().optional()])) as Record<
    FieldName,
    z.ZodOptional<z.ZodNullable<typeof RawField>>
  >,
);

/** JSON Schema given to Claude as the tool input schema (structured output). */
export const EXTRACTION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [...FIELD_NAMES],
  properties: Object.fromEntries(
    FIELD_NAMES.map((f) => [
      f,
      {
        type: 'object',
        additionalProperties: false,
        required: ['value', 'confidence', 'sourceExcerpt'],
        description: FIELD_LABELS[f],
        properties: {
          value: { type: ['string', 'null'], description: 'Value exactly as supported by the document, or null if not present' },
          confidence: { type: 'number', minimum: 0, maximum: 1, description: '0.00–1.00 certainty that the value is correct' },
          sourceExcerpt: {
            type: ['string', 'null'],
            description: 'Short verbatim quote from the document containing the value, or null',
          },
        },
      },
    ]),
  ),
} as const;

function normaliseForSearch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True if the excerpt (whitespace/quote-insensitive) occurs in the document. */
export function excerptIsGrounded(excerpt: string, documentText: string): boolean {
  const e = normaliseForSearch(excerpt).replace(/^\.{3}|\.{3}$/g, '').trim();
  if (e.length === 0) return false;
  return normaliseForSearch(documentText).includes(e);
}

function coerceConfidence(raw: unknown): number {
  let n = typeof raw === 'string' ? Number(raw.replace('%', '')) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(n)) return 0;
  if (n > 1 && n <= 100) n = n / 100; // model answered in percent
  return Math.min(1, Math.max(0, Math.round(n * 1000) / 1000));
}

/** Extract a JSON object from free text (handles ```json fences and surrounding prose). */
export function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new AiExtractionError('Model response did not contain a JSON object.', 'invalid_response');
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    throw new AiExtractionError('Model response contained malformed JSON.', 'invalid_response');
  }
}

/**
 * Validate + ground a raw model response.
 * @param raw  parsed JSON (tool input or text-extracted object)
 * @param documentText  the text the model was given
 */
export function parseExtractionResponse(
  raw: unknown,
  documentText: string,
): { fields: ExtractedFields; notes: string[] } {
  const parsed = RawResponse.safeParse(raw);
  if (!parsed.success) {
    throw new AiExtractionError('Model response did not match the extraction schema.', 'invalid_response');
  }
  const notes: string[] = [];
  const fields = {} as ExtractedFields;

  for (const f of FIELD_NAMES) {
    const r = parsed.data[f];
    const value = cleanValue(r?.value ?? null);
    let excerpt = cleanValue(r?.sourceExcerpt ?? null);
    if (excerpt && excerpt.length > 600) excerpt = excerpt.slice(0, 600) + '…';
    let confidence = coerceConfidence(r?.confidence);

    if (!r) notes.push(`${FIELD_LABELS[f]}: missing from model response; human entry required.`);

    if (value === null) {
      confidence = Math.min(confidence, MISSING_VALUE_MAX_CONFIDENCE);
    } else if (!excerpt) {
      if (confidence > NO_EXCERPT_MAX_CONFIDENCE) {
        notes.push(`${FIELD_LABELS[f]}: no source excerpt provided; confidence reduced.`);
      }
      confidence = Math.min(confidence, NO_EXCERPT_MAX_CONFIDENCE);
    } else if (!excerptIsGrounded(excerpt, documentText)) {
      notes.push(`${FIELD_LABELS[f]}: source excerpt not found in the document; confidence reduced for human verification.`);
      confidence = Math.min(confidence, UNGROUNDED_MAX_CONFIDENCE);
    }

    const field: ExtractedField = { value, confidence, sourceExcerpt: excerpt };
    fields[f] = field;
  }
  return { fields, notes };
}
