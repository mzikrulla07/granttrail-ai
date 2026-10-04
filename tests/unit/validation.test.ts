import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES } from '../../server/src/config.js';
import type { FieldValues } from '../../server/src/domain/fields.js';
import {
  addDays,
  calculateReportingDueDate,
  daysBetween,
  parseAmount,
  parseDate,
} from '../../server/src/domain/parsing.js';
import { assertApprovable, validateSubaward } from '../../server/src/domain/validation.js';

const TODAY = '2026-09-26';

const valid = (over: Partial<FieldValues> = {}): FieldValues => ({
  subrecipientName: 'Maple Street Community Shelter, Inc.',
  uei: 'MS4K7TQ2LZ81',
  amount: '$185,000.00',
  awardDate: '2026-09-10',
  placeOfPerformance: 'Riverbend, OH 45101',
  projectDescription: 'Operate a 40-bed emergency shelter with case management services.',
  ...over,
});

const run = (values: FieldValues, extra: Partial<Parameters<typeof validateSubaward>[0]> = {}) =>
  validateSubaward({ values, today: TODAY, rules: DEFAULT_RULES, ...extra });

const codes = (r: ReturnType<typeof run>, sev?: string) =>
  r.checks.filter((c) => !sev || c.severity === sev).map((c) => c.code);

describe('due-date calculation (end of month following the award month)', () => {
  it.each([
    ['2026-08-14', '2026-09-30'],
    ['2026-08-01', '2026-09-30'],
    ['2026-01-31', '2026-02-28'],
    ['2027-12-03', '2028-01-31'],
    ['2028-01-15', '2028-02-29'], // leap year
    ['2026-11-30', '2026-12-31'],
  ])('award %s → due %s', (award, due) => {
    expect(calculateReportingDueDate(award)).toBe(due);
  });

  it('computes day differences without time-zone drift', () => {
    expect(daysBetween('2026-09-26', '2026-09-30')).toBe(4);
    expect(daysBetween('2026-09-26', '2026-08-31')).toBe(-26);
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
  });
});

describe('date and amount parsing', () => {
  it.each([
    ['2026-08-14', '2026-08-14'],
    ['08/14/2026', '2026-08-14'],
    ['8-14-2026', '2026-08-14'],
    ['August 14, 2026', '2026-08-14'],
    ['Aug. 14 2026', '2026-08-14'],
    ['14 August 2026', '2026-08-14'],
    ['August 14th, 2026', '2026-08-14'],
  ])('parses %s', (raw, iso) => expect(parseDate(raw)).toBe(iso));

  it.each(['2026-02-30', '13/01/2026', 'soon', 'Smarch 3, 2026', ''])('rejects %s', (raw) => expect(parseDate(raw)).toBeNull());

  it.each([
    ['$185,000.00', '185000.00'],
    ['185000', '185000.00'],
    ['USD 1,234.5', '1234.50'],
    ['$ 92,500', '92500.00'],
  ])('parses amount %s', (raw, n) => expect(parseAmount(raw)).toMatchObject({ valid: true, normalized: n }));

  it.each([
    ['-500', /greater than \$0/],
    ['($500.00)', /negative/],
    ['0', /greater than \$0/],
    ['12.345', /two decimal places/],
    ['one hundred dollars', /Enter the amount/],
    ['1,00,000', /Enter the amount/],
    ['2000000000', /not plausible/],
  ])('rejects amount %s', (raw, msg) => {
    const r = parseAmount(raw);
    expect(r.valid).toBe(false);
    expect(r.problem).toMatch(msg);
  });
});

describe('validation engine', () => {
  it('passes a complete, valid record (not yet due soon)', () => {
    const r = run(valid());
    expect(r.status).toBe('PASS');
    expect(r.canApprove).toBe(true);
    expect(r.dueDate).toBe('2026-10-31');
    expect(r.timeliness).toBe('on_track');
    expect(r.normalized).toMatchObject({ uei: 'MS4K7TQ2LZ81', amount: '185000.00', awardDate: '2026-09-10' });
  });

  it('includes a human-readable message on every check', () => {
    for (const c of run(valid({ uei: 'bad' })).checks) {
      expect(c.message.length).toBeGreaterThan(10);
      expect(['PASS', 'WARNING', 'ERROR']).toContain(c.severity);
    }
  });

  describe('required fields', () => {
    it('flags every missing field as a blocking ERROR', () => {
      const r = run({
        subrecipientName: null,
        uei: null,
        amount: '',
        awardDate: '  ',
        placeOfPerformance: null,
        projectDescription: null,
      });
      expect(r.checks.filter((c) => c.code === 'REQUIRED_FIELD')).toHaveLength(6);
      expect(r.status).toBe('ERROR');
      expect(r.canApprove).toBe(false);
      expect(r.timeliness).toBe('unknown');
    });

    it('flags only the missing field', () => {
      const r = run(valid({ placeOfPerformance: null }));
      expect(r.checks.filter((c) => c.code === 'REQUIRED_FIELD').map((c) => c.field)).toEqual(['placeOfPerformance']);
      expect(r.fieldStatus.placeOfPerformance).toBe('ERROR');
      expect(r.fieldStatus.uei).toBe('PASS');
    });
  });

  it('UEI format errors block approval', () => {
    const r = run(valid({ uei: 'PR4O7XK2M9L' }));
    expect(r.fieldStatus.uei).toBe('ERROR');
    expect(r.canApprove).toBe(false);
  });

  describe('reporting threshold ($30,000)', () => {
    it('amount at the threshold must be reported', () => {
      const r = run(valid({ amount: '30000' }));
      expect(r.reportingRequired).toBe(true);
      expect(r.checks.find((c) => c.code === 'REPORTING_THRESHOLD')?.severity).toBe('PASS');
    });

    it('amount below the threshold is a WARNING, not an error', () => {
      const r = run(valid({ amount: '$29,999.99' }));
      expect(r.reportingRequired).toBe(false);
      expect(r.checks.find((c) => c.code === 'REPORTING_THRESHOLD')).toMatchObject({ severity: 'WARNING', blocking: false });
      expect(r.canApprove).toBe(true);
    });

    it('threshold is configurable', () => {
      const r = run(valid({ amount: '40000' }), { rules: { ...DEFAULT_RULES, reportingThreshold: 50_000 } });
      expect(r.reportingRequired).toBe(false);
    });

    it('invalid amounts are errors and skip the threshold check', () => {
      const r = run(valid({ amount: 'TBD' }));
      expect(codes(r, 'ERROR')).toContain('AMOUNT_FORMAT');
      expect(codes(r)).not.toContain('REPORTING_THRESHOLD');
    });
  });

  describe('award date and overdue status', () => {
    it('rejects future award dates', () => {
      expect(codes(run(valid({ awardDate: '2026-10-01' })), 'ERROR')).toContain('AWARD_DATE_FUTURE');
    });

    it('rejects impossible dates', () => {
      expect(codes(run(valid({ awardDate: 'February 30, 2026' })), 'ERROR')).toContain('AWARD_DATE_FORMAT');
    });

    it('warns on very old award dates', () => {
      expect(codes(run(valid({ awardDate: '2021-01-05' })), 'WARNING')).toContain('AWARD_DATE_AGE');
    });

    it('marks records past their due date as overdue (warning, not blocking)', () => {
      const r = run(valid({ awardDate: '2026-07-12' }));
      expect(r.dueDate).toBe('2026-08-31');
      expect(r.daysUntilDue).toBe(-26);
      expect(r.timeliness).toBe('overdue');
      expect(r.checks.find((c) => c.code === 'TIMELINESS')).toMatchObject({ severity: 'WARNING', blocking: false });
      expect(r.canApprove).toBe(true);
    });

    it('marks records due within the window as due soon', () => {
      const r = run(valid({ awardDate: '2026-08-19' }));
      expect(r.timeliness).toBe('due_soon');
      expect(r.daysUntilDue).toBe(4);
    });

    it('due today is due soon', () => {
      const r = run(valid({ awardDate: '2026-08-19' }), { today: '2026-09-30' });
      expect(r.daysUntilDue).toBe(0);
      expect(r.checks.find((c) => c.code === 'TIMELINESS')?.message).toMatch(/TODAY/);
    });

    it('reported records are never overdue', () => {
      const r = run(valid({ awardDate: '2026-05-09' }), { status: 'reported' });
      expect(r.timeliness).toBe('reported');
    });
  });

  it('warns when place of performance lacks state and ZIP', () => {
    expect(codes(run(valid({ placeOfPerformance: 'Riverbend, Ohio' })), 'WARNING')).toContain('PLACE_FORMAT');
  });

  it('description limits', () => {
    expect(codes(run(valid({ projectDescription: 'Shelter.' })), 'WARNING')).toContain('DESCRIPTION_LENGTH');
    expect(codes(run(valid({ projectDescription: 'x'.repeat(4001) })), 'ERROR')).toContain('DESCRIPTION_LENGTH');
  });

  describe('low-confidence extraction', () => {
    const meta = { uei: { confidence: 0.55, humanEdited: false } };
    it('warns on AI values below the confidence threshold', () => {
      const r = run(valid(), { meta });
      expect(r.checks.find((c) => c.code === 'LOW_CONFIDENCE')).toMatchObject({ field: 'uei', severity: 'WARNING' });
    });
    it('does not warn once a human has edited/confirmed the value', () => {
      const r = run(valid(), { meta: { uei: { confidence: 0.55, humanEdited: true } } });
      expect(codes(r)).not.toContain('LOW_CONFIDENCE');
    });
  });
});

describe('approval blocking', () => {
  it('allows approval when only warnings remain', () => {
    const gate = assertApprovable(run(valid({ amount: '10000', awardDate: '2026-07-01' })));
    expect(gate).toEqual({ allowed: true, reasons: [] });
  });

  it('blocks approval and explains every blocking error', () => {
    const gate = assertApprovable(run(valid({ uei: 'LH7I2Q9MXV51', amount: null })));
    expect(gate.allowed).toBe(false);
    expect(gate.reasons).toHaveLength(2);
    expect(gate.reasons.join(' ')).toMatch(/UEI/);
    expect(gate.reasons.join(' ')).toMatch(/Subaward amount is required/);
  });

  it('is deterministic — same input, same output', () => {
    const a = run(valid({ uei: 'bad' }));
    const b = run(valid({ uei: 'bad' }));
    expect(a).toEqual(b);
  });
});
