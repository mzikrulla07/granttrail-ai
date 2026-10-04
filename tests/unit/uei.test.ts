import { describe, expect, it } from 'vitest';
import { checkUei, normalizeUei, UEI_PATTERN } from '../../server/src/domain/parsing.js';

describe('UEI validation', () => {
  it('accepts a well-formed 12-character UEI', () => {
    expect(checkUei('MS4K7TQ2LZ81')).toEqual({ valid: true, normalized: 'MS4K7TQ2LZ81' });
  });

  it('normalises case, spaces and hyphens before checking', () => {
    expect(normalizeUei(' ms4k-7tq2 lz81 ')).toBe('MS4K7TQ2LZ81');
    expect(checkUei('ms4k-7tq2-lz81').valid).toBe(true);
  });

  it.each([
    ['PR4O7XK2M9L', /exactly 12 characters/],
    ['MS4K7TQ2LZ81X', /exactly 12 characters/],
    ['', /exactly 12 characters/],
  ])('rejects wrong length: %s', (v, msg) => {
    const r = checkUei(v);
    expect(r.valid).toBe(false);
    expect(r.problem).toMatch(msg);
  });

  it('rejects the letters I and O (never used in UEIs)', () => {
    expect(checkUei('LH7I2Q9MXV51')).toMatchObject({ valid: false, problem: expect.stringMatching(/"I" or "O"/) });
    expect(checkUei('OK2V7C4HPN93')).toMatchObject({ valid: false });
  });

  it('rejects a leading zero', () => {
    expect(checkUei('0S4K7TQ2LZ81')).toMatchObject({ valid: false, problem: expect.stringMatching(/cannot begin with/) });
  });

  it('rejects punctuation', () => {
    expect(checkUei('MS4K7TQ2LZ8!').valid).toBe(false);
  });

  it('pattern excludes I and O anywhere', () => {
    expect(UEI_PATTERN.test('ABCDEFGHJKLM')).toBe(true);
    expect(UEI_PATTERN.test('ABCDEFGHIJKL')).toBe(false);
  });
});
