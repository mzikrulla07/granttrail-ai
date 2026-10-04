import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { ClaudeExtractor, describeApiError, EXTRACTION_TOOL_NAME, redact, type MessagesClient } from '../../server/src/ai/claudeExtractor.js';
import { DemoExtractor, simulateExtraction } from '../../server/src/ai/demoExtractor.js';
import {
  excerptIsGrounded,
  extractJsonObject,
  parseExtractionResponse,
  UNGROUNDED_MAX_CONFIDENCE,
} from '../../server/src/ai/responseParser.js';
import { AiExtractionError } from '../../server/src/ai/types.js';

const DOC = `Subrecipient Legal Name: Harbor Light Tenant Services
Unique Entity ID (UEI): HL8R2W6NXC34
Subaward Amount: $92,500.00
Award Date: 08/08/2026
Place of Performance: Port Lessing, OH 45144
Project Description: Provide tenancy-sustaining services and landlord
mediation for 120 households at risk of eviction.`;

const good = {
  subrecipientName: { value: 'Harbor Light Tenant Services', confidence: 0.97, sourceExcerpt: 'Subrecipient Legal Name: Harbor Light Tenant Services' },
  uei: { value: 'HL8R2W6NXC34', confidence: 0.96, sourceExcerpt: 'Unique Entity ID (UEI): HL8R2W6NXC34' },
  amount: { value: '$92,500.00', confidence: 0.95, sourceExcerpt: 'Subaward Amount: $92,500.00' },
  awardDate: { value: '08/08/2026', confidence: 0.94, sourceExcerpt: 'Award Date: 08/08/2026' },
  placeOfPerformance: { value: 'Port Lessing, OH 45144', confidence: 0.9, sourceExcerpt: 'Place of Performance: Port Lessing, OH 45144' },
  projectDescription: {
    value: 'Provide tenancy-sustaining services and landlord mediation for 120 households at risk of eviction.',
    confidence: 0.88,
    // spans a line break in the document — must still be grounded
    sourceExcerpt: 'Provide tenancy-sustaining services and landlord mediation for 120 households',
  },
};

describe('AI response parsing', () => {
  it('accepts a valid structured response and keeps confidences', () => {
    const { fields, notes } = parseExtractionResponse(good, DOC);
    expect(fields.uei).toEqual(good.uei);
    expect(fields.projectDescription.confidence).toBe(0.88);
    expect(notes).toEqual([]);
  });

  it('forces low confidence for null values ("never invent a value")', () => {
    const { fields } = parseExtractionResponse({ ...good, uei: { value: null, confidence: 0.9, sourceExcerpt: null } }, DOC);
    expect(fields.uei.value).toBeNull();
    expect(fields.uei.confidence).toBeLessThanOrEqual(0.1);
  });

  it('treats a missing field as null with zero confidence', () => {
    const { uei: _omit, ...rest } = good;
    const { fields, notes } = parseExtractionResponse(rest, DOC);
    expect(fields.uei).toEqual({ value: null, confidence: 0, sourceExcerpt: null });
    expect(notes.join(' ')).toMatch(/missing from model response/);
  });

  it('caps confidence when the excerpt is not in the document (possible hallucination)', () => {
    const { fields, notes } = parseExtractionResponse(
      { ...good, uei: { value: 'ZZ9Z9Z9Z9Z9Z', confidence: 0.99, sourceExcerpt: 'UEI: ZZ9Z9Z9Z9Z9Z' } },
      DOC,
    );
    expect(fields.uei.confidence).toBe(UNGROUNDED_MAX_CONFIDENCE);
    expect(notes.join(' ')).toMatch(/not found in the document/);
  });

  it('caps confidence when no excerpt is given for a value', () => {
    const { fields } = parseExtractionResponse({ ...good, amount: { value: '$92,500.00', confidence: 0.99, sourceExcerpt: null } }, DOC);
    expect(fields.amount.confidence).toBe(0.5);
  });

  it('normalises percent-style and string confidences, clamps to [0,1]', () => {
    const { fields } = parseExtractionResponse(
      {
        ...good,
        uei: { ...good.uei, confidence: 96 },
        amount: { ...good.amount, confidence: '0.9' },
        awardDate: { ...good.awardDate, confidence: -3 },
        placeOfPerformance: { ...good.placeOfPerformance, confidence: 'high' },
      },
      DOC,
    );
    expect(fields.uei.confidence).toBe(0.96);
    expect(fields.amount.confidence).toBe(0.9);
    expect(fields.awardDate.confidence).toBe(0);
    expect(fields.placeOfPerformance.confidence).toBe(0);
  });

  it('coerces numeric values to strings and trims whitespace', () => {
    const { fields } = parseExtractionResponse({ ...good, amount: { value: 92500, confidence: 0.9, sourceExcerpt: '$92,500.00' } }, DOC);
    expect(fields.amount.value).toBe('92500');
  });

  it('rejects responses that do not match the schema', () => {
    expect(() => parseExtractionResponse({ uei: 'HL8R2W6NXC34' }, DOC)).toThrow(AiExtractionError);
    expect(() => parseExtractionResponse('nonsense', DOC)).toThrow(AiExtractionError);
  });

  it('extracts JSON from fenced or chatty text', () => {
    expect(extractJsonObject('Here you go:\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(extractJsonObject('Result: {"a": {"b": 2}} done')).toEqual({ a: { b: 2 } });
    expect(() => extractJsonObject('no json here')).toThrow(AiExtractionError);
    expect(() => extractJsonObject('{"a": ')).toThrow(AiExtractionError);
  });

  it('grounding is whitespace-, case- and smart-quote-insensitive', () => {
    expect(excerptIsGrounded('award date:   08/08/2026', DOC)).toBe(true);
    expect(excerptIsGrounded('the “Subrecipient”', 'the "Subrecipient" agrees')).toBe(true);
    expect(excerptIsGrounded('', DOC)).toBe(false);
  });
});

function fakeClient(content: Anthropic.ContentBlock[] | Error): MessagesClient & { calls: Anthropic.MessageCreateParamsNonStreaming[] } {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  return {
    calls,
    messages: {
      async create(params) {
        calls.push(params);
        if (content instanceof Error) throw content;
        return { id: 'msg_test', type: 'message', role: 'assistant', model: params.model, content, stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } as unknown as Anthropic.Message;
      },
    },
  };
}

describe('ClaudeExtractor (with a fake Anthropic client — no network)', () => {
  const opts = { model: 'claude-test', timeoutMs: 10_000, maxInputChars: 50_000 };

  it('forces the structured-output tool and parses its input', async () => {
    const client = fakeClient([{ type: 'tool_use', id: 't1', name: EXTRACTION_TOOL_NAME, input: good } as Anthropic.ToolUseBlock]);
    const r = await new ClaudeExtractor({ ...opts, client }).extract(DOC);
    expect(r.mode).toBe('claude');
    expect(r.fields.uei.value).toBe('HL8R2W6NXC34');
    const call = client.calls[0]!;
    expect(call.tool_choice).toEqual({ type: 'tool', name: EXTRACTION_TOOL_NAME });
    expect(JSON.stringify(call.messages)).toContain('<agreement>');
    expect(call.system).toMatch(/Never guess, infer, calculate, or invent/);
    expect(call.system).toMatch(/Do not decide whether the record is compliant/);
  });

  it('falls back to JSON in a text block', async () => {
    const client = fakeClient([{ type: 'text', text: '```json\n' + JSON.stringify(good) + '\n```', citations: null } as Anthropic.TextBlock]);
    const r = await new ClaudeExtractor({ ...opts, client }).extract(DOC);
    expect(r.fields.amount.value).toBe('$92,500.00');
  });

  it('wraps API failures in a sanitised AiExtractionError', async () => {
    const client = fakeClient(new Error('401 invalid x-api-key sk-ant-secret'));
    const err = await new ClaudeExtractor({ ...opts, client }).extract(DOC).catch((e) => e);
    expect(err).toBeInstanceOf(AiExtractionError);
    expect(err.reason).toBe('api_error');
    expect(err.message).not.toMatch(/sk-ant/);
  });

  it('captures safe diagnostics (status, type, hint) from API errors', async () => {
    const apiErr = Object.assign(new Error('400 {"type":"error"}'), {
      status: 400,
      error: { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } },
    });
    const err = await new ClaudeExtractor({ ...opts, client: fakeClient(apiErr) }).extract(DOC).catch((e) => e);
    expect(err.diagnostic).toMatchObject({ httpStatus: 400, errorType: 'invalid_request_error', hint: expect.stringMatching(/credit/i) });
    expect(describeApiError(Object.assign(new Error('x'), { status: 401 })).hint).toMatch(/sk-ant-/);
    expect(describeApiError(new Error('fetch failed')).hint).toMatch(/Could not reach/);
    expect(redact('invalid x-api-key sk-ant-api03-abcDEF_123-xyz')).toBe('invalid x-api-key sk-ant-[REDACTED]');
  });

  it('truncates very long documents and says so', async () => {
    const client = fakeClient([{ type: 'tool_use', id: 't1', name: EXTRACTION_TOOL_NAME, input: good } as Anthropic.ToolUseBlock]);
    const r = await new ClaudeExtractor({ ...opts, maxInputChars: 5000, client }).extract(DOC + 'x'.repeat(10_000));
    expect(r.notes[0]).toMatch(/truncated/);
    expect(JSON.stringify(client.calls[0]!.messages).length).toBeLessThan(7000);
  });

  it('refuses to construct without a key or client', () => {
    expect(() => new ClaudeExtractor(opts)).toThrow(AiExtractionError);
  });
});

describe('DemoExtractor (simulated extraction)', () => {
  it('extracts labelled fields with high confidence', async () => {
    const r = await new DemoExtractor(0).extract(DOC);
    expect(r.mode).toBe('demo');
    expect(r.fields.subrecipientName.value).toBe('Harbor Light Tenant Services');
    expect(r.fields.uei.confidence).toBeGreaterThan(0.9);
    expect(r.notes[0]).toMatch(/DEMO MODE/);
  });

  it('returns null + zero confidence when a field is absent (never invents)', () => {
    const r = simulateExtraction('This agreement is between two parties. No other details.');
    expect(r.uei).toEqual({ value: null, confidence: 0, sourceExcerpt: null });
    expect(r.amount.value).toBeNull();
  });
});
