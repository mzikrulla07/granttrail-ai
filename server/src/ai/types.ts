import type { FieldName } from '../domain/fields.js';

/** Shape returned for every extracted field (the contract in the project brief). */
export interface ExtractedField {
  value: string | null;
  /** 0.00 – 1.00 */
  confidence: number;
  /** Verbatim text from the agreement supporting the value, or null */
  sourceExcerpt: string | null;
}

export type ExtractedFields = Record<FieldName, ExtractedField>;

export interface ExtractionResult {
  fields: ExtractedFields;
  mode: 'demo' | 'claude';
  model: string;
  /** Post-processing notes, e.g. "excerpt not found in document; confidence reduced" */
  notes: string[];
}

export interface Extractor {
  readonly mode: 'demo' | 'claude';
  readonly model: string;
  extract(documentText: string): Promise<ExtractionResult>;
}

export class AiExtractionError extends Error {
  constructor(
    message: string,
    readonly reason: 'timeout' | 'api_error' | 'invalid_response' | 'configuration',
    /** Safe diagnostic detail (HTTP status, API error type) — never contains credentials */
    readonly diagnostic?: { httpStatus?: number; errorType?: string; hint?: string },
  ) {
    super(message);
    this.name = 'AiExtractionError';
  }
}
