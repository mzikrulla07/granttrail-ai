/**
 * SAM.gov-ready CSV export.
 *
 * Columns follow the federal subaward report data elements (FFATA /
 * 2 CFR Part 170). SAM.gov publishes its own bulk-upload template; before
 * production use, map these columns to the current template version — the
 * column list is centralised in EXPORT_COLUMNS for exactly that reason.
 */

export interface ExportRow {
  primeAwardId: string;
  primeAwardeeName: string;
  subrecipientName: string;
  subrecipientUei: string;
  subawardAmount: string;
  subawardDate: string;
  placeOfPerformance: string;
  subawardDescription: string;
  reportingDueDate: string;
  approvedBy: string;
  approvedAt: string;
  recordId: string;
}

export const EXPORT_COLUMNS: { key: keyof ExportRow; header: string }[] = [
  { key: 'primeAwardId', header: 'Prime Award ID (FAIN)' },
  { key: 'primeAwardeeName', header: 'Prime Awardee Name' },
  { key: 'subrecipientName', header: 'Subawardee Name' },
  { key: 'subrecipientUei', header: 'Subawardee UEI' },
  { key: 'subawardAmount', header: 'Subaward Amount' },
  { key: 'subawardDate', header: 'Subaward Action Date' },
  { key: 'placeOfPerformance', header: 'Place of Performance' },
  { key: 'subawardDescription', header: 'Subaward Description' },
  { key: 'reportingDueDate', header: 'Report Due Date' },
  { key: 'approvedBy', header: 'Approved By' },
  { key: 'approvedAt', header: 'Approved At (UTC)' },
  { key: 'recordId', header: 'GrantTrail Record ID' },
];

/**
 * Escape one CSV cell (RFC 4180) and neutralise spreadsheet formula injection:
 * a cell that begins with = + - @ tab or CR is prefixed with an apostrophe so
 * Excel/Sheets treat it as text.
 */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function buildCsv(rows: ExportRow[]): string {
  const header = EXPORT_COLUMNS.map((c) => csvCell(c.header)).join(',');
  const body = rows.map((r) => EXPORT_COLUMNS.map((c) => csvCell(r[c.key])).join(','));
  // CRLF line endings per RFC 4180; BOM so Excel opens UTF-8 correctly.
  return '﻿' + [header, ...body].join('\r\n') + '\r\n';
}
