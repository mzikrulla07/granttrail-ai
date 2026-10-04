/**
 * Deterministic parsers/normalisers for extracted values.
 * Pure functions — no I/O, no AI — so they are fully unit-testable.
 */

// ---------------------------------------------------------------- UEI

/** SAM.gov UEI alphabet: digits 0-9 and letters A-Z excluding I and O. */
export const UEI_PATTERN = /^[A-HJ-NP-Z1-9][A-HJ-NP-Z0-9]{11}$/;

export function normalizeUei(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]/g, '');
}

export interface UeiCheck {
  valid: boolean;
  normalized: string;
  problem?: string;
}

export function checkUei(raw: string): UeiCheck {
  const normalized = normalizeUei(raw);
  if (normalized.length !== 12) {
    return {
      valid: false,
      normalized,
      problem: `A UEI must be exactly 12 characters; this value has ${normalized.length}.`,
    };
  }
  if (/[^A-Z0-9]/.test(normalized)) {
    return { valid: false, normalized, problem: 'A UEI may contain only letters and digits.' };
  }
  if (/[IO]/.test(normalized)) {
    return {
      valid: false,
      normalized,
      problem:
        'A UEI never contains the letters "I" or "O". Check for a misread "1" or "0" in the source document.',
    };
  }
  if (normalized.startsWith('0')) {
    return { valid: false, normalized, problem: 'A UEI cannot begin with the digit 0.' };
  }
  return { valid: UEI_PATTERN.test(normalized), normalized };
}

// ---------------------------------------------------------------- Money

export interface AmountCheck {
  valid: boolean;
  /** Canonical two-decimal string, e.g. "185000.00" */
  normalized?: string;
  value?: number;
  problem?: string;
}

export const MAX_PLAUSIBLE_AMOUNT = 1_000_000_000;

export function parseAmount(raw: string): AmountCheck {
  let s = raw.trim().replace(/^(USD|US\$)\s*/i, '').replace(/\s*(USD|dollars)$/i, '');
  if (s.startsWith('(') && s.endsWith(')')) {
    return { valid: false, problem: 'The amount appears to be negative. A subaward amount must be positive.' };
  }
  s = s.replace(/^\$\s*/, '');
  if (s.startsWith('-')) {
    return { valid: false, problem: 'A subaward amount must be greater than $0.' };
  }
  if (!/^\d{1,3}(,\d{3})*(\.\d+)?$|^\d+(\.\d+)?$/.test(s)) {
    return {
      valid: false,
      problem: 'Enter the amount as a number, for example 185000 or $185,000.00.',
    };
  }
  const plain = s.replace(/,/g, '');
  const [, decimals = ''] = plain.split('.');
  if (decimals.length > 2) {
    return { valid: false, problem: 'Amounts cannot have more than two decimal places (cents).' };
  }
  const value = Number(plain);
  if (!Number.isFinite(value) || value <= 0) {
    return { valid: false, problem: 'A subaward amount must be greater than $0.' };
  }
  if (value > MAX_PLAUSIBLE_AMOUNT) {
    return {
      valid: false,
      problem: 'The amount exceeds $1,000,000,000, which is not plausible for a subaward. Check for extra digits.',
    };
  }
  return { valid: true, value, normalized: value.toFixed(2) };
}

export function formatUsd(value: number | string): string {
  const n = typeof value === 'string' ? Number(value) : value;
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

// ---------------------------------------------------------------- Dates

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function isoFromParts(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Parse common agreement date formats into ISO `YYYY-MM-DD`.
 * Accepts: 2026-08-14, 08/14/2026, 8-14-2026, August 14, 2026, 14 August 2026, Aug. 14 2026.
 * Returns null for anything ambiguous or impossible (e.g. February 30).
 */
export function parseDate(raw: string): string | null {
  const s = raw.trim().replace(/(\d)(st|nd|rd|th)\b/gi, '$1');
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return isoFromParts(+m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
  if (m) return isoFromParts(+m[3]!, +m[1]!, +m[2]!);
  m = /^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m) {
    const mon = MONTHS[m[1]!.toLowerCase()];
    return mon ? isoFromParts(+m[3]!, mon, +m[2]!) : null;
  }
  m = /^(\d{1,2})\s+([A-Za-z]+)\.?,?\s+(\d{4})$/.exec(s);
  if (m) {
    const mon = MONTHS[m[2]!.toLowerCase()];
    return mon ? isoFromParts(+m[3]!, mon, +m[1]!) : null;
  }
  return null;
}

/** Today's date in the server's local time zone as YYYY-MM-DD. */
export function todayIso(now: Date = new Date()): string {
  return isoFromParts(now.getFullYear(), now.getMonth() + 1, now.getDate())!;
}

function toUtc(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

/** Whole days from `from` to `to` (positive when `to` is later). */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtc(to) - toUtc(from)) / 86_400_000);
}

export function addDays(iso: string, days: number): string {
  const dt = new Date(toUtc(iso) + days * 86_400_000);
  return dt.toISOString().slice(0, 10);
}

/**
 * Federal subaward reports are due by the end of the month following the
 * month in which the subaward was made (2 CFR Part 170, Appendix A).
 *   2026-08-14 → 2026-09-30,   2026-12-03 → 2027-01-31
 */
export function calculateReportingDueDate(awardDateIso: string): string {
  const [y, m] = awardDateIso.split('-').map(Number) as [number, number];
  // Day 0 of month (m + 2) is the last day of month (m + 1).
  const last = new Date(Date.UTC(y, m + 1, 0));
  return last.toISOString().slice(0, 10);
}

export function formatLongDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}
