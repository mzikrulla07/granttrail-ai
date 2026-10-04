import { describe, expect, it } from 'vitest';
import { buildCsv, csvCell, EXPORT_COLUMNS } from '../../server/src/services/csv.js';
import { scoreField, summarize, tokenF1 } from '../../server/src/evaluation/scoring.js';
import { sanitizeFilename } from '../../server/src/pdf/pdf.js';

describe('CSV export', () => {
  it('quotes commas, quotes and newlines (RFC 4180)', () => {
    expect(csvCell('Riverbend, OH')).toBe('"Riverbend, OH"');
    expect(csvCell('the "Subrecipient"')).toBe('"the ""Subrecipient"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvCell(null)).toBe('');
  });

  it('neutralises spreadsheet formula injection', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe(`"'=HYPERLINK(""http://evil"")"`);
    expect(csvCell('+1+1')).toBe("'+1+1");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  it('writes a header row, BOM and CRLF line endings', () => {
    const csv = buildCsv([]);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain(EXPORT_COLUMNS.map((c) => c.header).join(','));
    expect(csv.endsWith('\r\n')).toBe(true);
  });
});

describe('safe filenames', () => {
  it('strips paths and unsafe characters', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd.pdf');
    expect(sanitizeFilename('C:\\Users\\me\\Agreement <final>.pdf')).toBe('Agreement _final_.pdf');
    expect(sanitizeFilename(undefined)).toBe('agreement.pdf');
    expect(sanitizeFilename('.hidden.pdf')).toBe('hidden.pdf');
  });
});

describe('evaluation scoring', () => {
  it('compares UEI, amount and date after normalisation', () => {
    expect(scoreField('uei', 'hl8r-2w6n-xc34', 'HL8R2W6NXC34', 0.9).correct).toBe(true);
    expect(scoreField('amount', '$92,500.00', '92500', 0.9).correct).toBe(true);
    expect(scoreField('awardDate', 'August 8, 2026', '08/08/2026', 0.9).correct).toBe(true);
    expect(scoreField('amount', '$92,500.00', '$95,200.00', 0.9).correct).toBe(false);
  });

  it('scores descriptions by token F1', () => {
    expect(tokenF1('provide rapid rehousing', 'provide rapid rehousing')).toBe(1);
    expect(scoreField('projectDescription', 'Provide rapid rehousing to 45 families.', 'Provide rapid rehousing to 45 families', 0.8).correct).toBe(true);
  });

  it('counts correct absence and hallucinations', () => {
    expect(scoreField('uei', null, null, 0).correct).toBe(true);
    const s = summarize([[scoreField('uei', null, 'AB12CD34EF56', 0.95), scoreField('amount', '$1.00', '$2.00', 0.3)]], 0.75);
    expect(s.hallucinations).toBe(1);
    expect(s.confidentErrors).toBe(1);
    expect(s.flaggedErrors).toBe(1);
  });
});
