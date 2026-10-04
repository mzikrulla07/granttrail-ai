/**
 * DEMO MODE extractor — a SIMULATION of AI extraction.
 *
 * Used when no Claude API key is configured so the full workflow can be
 * demonstrated locally. It applies labelled-field patterns to the PDF text and
 * produces the same structured shape Claude does (value, confidence,
 * sourceExcerpt). Confidence is rule-based: an explicitly labelled value scores
 * high; a value found only by a looser fallback pattern scores low, which
 * exercises the "low confidence — verify" workflow.
 *
 * Its output flows through the same schema validation and excerpt-grounding
 * as real Claude output (responseParser.ts).
 */
import type { FieldName } from '../domain/fields.js';
import { parseExtractionResponse } from './responseParser.js';
import type { ExtractionResult, Extractor } from './types.js';

export const DEMO_MODEL_NAME = 'demo-rule-based-simulator';

interface Rule {
  pattern: RegExp;
  confidence: number;
  /** capture group holding the value (default 1) */
  group?: number;
}

const HEADING = /\n\s*(?:Section\s+\d+|\d+\.\s+[A-Z]|ARTICLE|[A-Z][A-Z ]{6,}\n)/;

const RULES: Record<FieldName, Rule[]> = {
  subrecipientName: [
    { pattern: /^\s*Subrecipient(?:\s+Legal)?\s+Name\s*:\s*([^\n]+)/im, confidence: 0.97 },
    { pattern: /^\s*Subrecipient\s*:\s*([^\n]+)/im, confidence: 0.94 },
    { pattern: /\band\s+([A-Z][A-Za-z0-9&.,' -]{3,120}?)\s*(?:\(UEI[^)]*\)\s*)?\(\s*(?:the\s+)?["“]?Subrecipient/i, confidence: 0.68 },
  ],
  uei: [
    { pattern: /Unique\s+Entity\s+(?:ID|Identifier)(?:\s*\(UEI\))?\s*:\s*([A-Za-z0-9][A-Za-z0-9 -]{9,16}[A-Za-z0-9])/i, confidence: 0.96 },
    { pattern: /\bUEI\s*(?:No\.?|Number|#)?\s*:\s*([A-Za-z0-9][A-Za-z0-9 -]{9,16}[A-Za-z0-9])/i, confidence: 0.93 },
    { pattern: /\bUEI\b[^\n]{0,40}?\b([A-Z0-9]{12})\b/, confidence: 0.55 },
  ],
  amount: [
    { pattern: /(?:Total\s+)?Subaward\s+Amount\s*:\s*(\$\s?[\d,]+(?:\.\d{1,2})?)/i, confidence: 0.97 },
    { pattern: /(?:amount\s+not\s+to\s+exceed|total\s+federal\s+(?:funds|award)\s+(?:obligated|of))\s*(\$\s?[\d,]+(?:\.\d{1,2})?)/i, confidence: 0.84 },
    { pattern: /(\$\s?[\d,]{5,}(?:\.\d{2})?)/, confidence: 0.45 },
  ],
  awardDate: [
    { pattern: /(?:Subaward\s+)?(?:Award|Effective|Execution)\s+Date\s*:\s*([A-Za-z]+\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})/i, confidence: 0.95 },
    { pattern: /(?:entered\s+into|effective)\s+(?:as\s+of\s+|on\s+)?([A-Za-z]+\.?\s+\d{1,2},?\s+\d{4})/i, confidence: 0.66 },
  ],
  placeOfPerformance: [
    { pattern: /Place\s+of\s+Performance\s*:\s*([^\n]+)/i, confidence: 0.92 },
    { pattern: /services\s+(?:will\s+be\s+)?(?:delivered|performed|provided)\s+(?:at|in)\s+([^.\n]+)/i, confidence: 0.58 },
  ],
  projectDescription: [
    { pattern: /(?:Project\s+Description|Purpose\s+of\s+(?:the\s+)?Subaward)\s*:\s*([\s\S]+?)(?=\n\s*\n|\n\s*Section\s+\d|$)/i, confidence: 0.9 },
    { pattern: /Scope\s+of\s+Work\s*[:.]?\s*\n([\s\S]{20,600}?)(?=\n\s*\n|\n\s*Section\s+\d|\n\s*Services\s+will|$)/i, confidence: 0.62 },
  ],
};

/** Grab the line(s) around a match to serve as the verbatim source excerpt. */
function excerptAround(text: string, index: number, length: number): string {
  const lineStart = text.lastIndexOf('\n', index) + 1;
  let lineEnd = text.indexOf('\n', index + length);
  if (lineEnd === -1) lineEnd = text.length;
  let excerpt = text.slice(lineStart, Math.max(lineEnd, index + length)).trim();
  if (excerpt.length > 300) excerpt = excerpt.slice(0, 300).trim();
  return excerpt;
}

function stripTrailingHeading(s: string): string {
  const m = HEADING.exec('\n' + s);
  return m ? s.slice(0, Math.max(0, m.index - 1)) : s;
}

export function simulateExtraction(documentText: string): Record<FieldName, { value: string | null; confidence: number; sourceExcerpt: string | null }> {
  const text = documentText.replace(/\r\n?/g, '\n');
  const out = {} as Record<FieldName, { value: string | null; confidence: number; sourceExcerpt: string | null }>;

  for (const [field, rules] of Object.entries(RULES) as [FieldName, Rule[]][]) {
    out[field] = { value: null, confidence: 0, sourceExcerpt: null };
    for (const rule of rules) {
      const m = rule.pattern.exec(text);
      const captured = m?.[rule.group ?? 1];
      if (!m || !captured) continue;
      let value = captured.replace(/\s+/g, ' ').trim().replace(/[;,]$/, '');
      if (field === 'projectDescription') value = stripTrailingHeading(captured).replace(/\s+/g, ' ').trim();
      if (field === 'subrecipientName') value = value.replace(/\s*\(.*$/, '').trim();
      if (!value) continue;
      const valueIndex = m.index + m[0].indexOf(captured);
      const excerpt =
        field === 'projectDescription'
          ? value.slice(0, 280)
          : excerptAround(text, valueIndex, captured.length);
      out[field] = { value, confidence: rule.confidence, sourceExcerpt: excerpt };
      break;
    }
  }
  return out;
}

export class DemoExtractor implements Extractor {
  readonly mode = 'demo' as const;
  readonly model = DEMO_MODEL_NAME;

  /** @param latencyMs simulated processing time so the UI loading state is visible */
  constructor(private readonly latencyMs = 900) {}

  async extract(documentText: string): Promise<ExtractionResult> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
    const raw = simulateExtraction(documentText);
    const { fields, notes } = parseExtractionResponse(raw, documentText);
    return { fields, notes: ['DEMO MODE: values produced by the rule-based extraction simulator, not by Claude.', ...notes], mode: 'demo', model: this.model };
  }
}
