import type { SubawardStatus, Timeliness } from '../api/types';

export function formatCurrency(v: string | number | null | undefined, opts: { compact?: boolean } = {}): string {
  if (v === null || v === undefined || v === '') return '—';
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: opts.compact ? 'compact' : 'standard',
    maximumFractionDigits: opts.compact ? 1 : 2,
  });
}

/** Format an ISO date (YYYY-MM-DD) without time-zone drift. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function dueLabel(days: number | null, timeliness: Timeliness): string {
  if (timeliness === 'reported') return 'Reported';
  if (days === null) return 'Due date unknown';
  if (days < 0) return `${-days} day${days === -1 ? '' : 's'} overdue`;
  if (days === 0) return 'Due today';
  return `Due in ${days} day${days === 1 ? '' : 's'}`;
}

export const STATUS_LABELS: Record<SubawardStatus, string> = {
  awaiting_review: 'Awaiting Review',
  approved: 'Approved',
  reported: 'Reported',
};

export const EVENT_LABELS: Record<string, string> = {
  document_uploaded: 'Document uploaded',
  ai_extraction_completed: 'AI extraction completed',
  ai_extraction_failed: 'AI extraction failed',
  field_edited: 'Field edited',
  validation_performed: 'Validation performed',
  record_approved: 'Record approved',
  export_generated: 'Export generated',
  status_changed: 'Status changed',
};

const STATUS_WORDS: Record<string, string> = {
  awaiting_review: 'Awaiting Review',
  approved: 'Approved',
  reported: 'Reported',
};

const show = (v: unknown) => (v === null || v === undefined || v === '' ? '(empty)' : `“${String(v)}”`);

/** One-line, human-readable summary of an audit event. */
export function describeEvent(type: string, d: Record<string, unknown>): string {
  switch (type) {
    case 'document_uploaded':
      return `Uploaded ${d.filename} (${d.pageCount ?? '?'} page${d.pageCount === 1 ? '' : 's'}, ${formatBytes(Number(d.sizeBytes ?? 0))})`;
    case 'ai_extraction_completed':
      return d.mode === 'demo'
        ? 'Six fields extracted by the DEMO MODE simulator (not Claude)'
        : `Six fields extracted by Claude (${d.model})`;
    case 'ai_extraction_failed': {
      const status = d.httpStatus ? `, HTTP ${d.httpStatus}${d.errorType ? ` ${d.errorType}` : ''}` : '';
      return `Extraction failed (${d.reason}${status}). ${d.hint ? `${d.hint} ` : ''}All fields require manual entry.`;
    }
    case 'field_edited':
      return `${d.label}: ${show(d.previousValue)} → ${show(d.newValue)}`;
    case 'validation_performed': {
      const trig: Record<string, string> = {
        initial_extraction: 'after extraction',
        save_draft: 'after saving draft',
        approval: 'at approval',
        manual: 'on request',
      };
      return `Result ${d.result}: ${d.blockingErrors} blocking error${d.blockingErrors === 1 ? '' : 's'}, ${d.warnings} warning${d.warnings === 1 ? '' : 's'} (${trig[String(d.trigger)] ?? d.trigger})`;
    }
    case 'record_approved': {
      const w = Array.isArray(d.warningsAcknowledged) ? d.warningsAcknowledged.length : 0;
      return `Approved by reviewer with validation status ${d.validationStatus}${w ? `; ${w} warning${w === 1 ? '' : 's'} acknowledged` : ''}`;
    }
    case 'export_generated':
      return `${d.format} generated — ${d.filename}`;
    case 'status_changed':
      return `Status ${STATUS_WORDS[String(d.from)] ?? d.from} → ${STATUS_WORDS[String(d.to)] ?? d.to}${d.submissionReference ? ` (reference ${d.submissionReference})` : ''}`;
    default:
      return type;
  }
}
