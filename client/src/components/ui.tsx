import { useEffect, useId, useRef, type ReactNode } from 'react';
import type { Severity, SubawardStatus, Timeliness } from '../api/types';
import { dueLabel, STATUS_LABELS } from '../lib/format';

// ---------------------------------------------------------------- icons

type IconName =
  | 'dashboard'
  | 'upload'
  | 'list'
  | 'audit'
  | 'check'
  | 'warning'
  | 'error'
  | 'info'
  | 'file'
  | 'download'
  | 'clock'
  | 'close'
  | 'search'
  | 'menu'
  | 'shield'
  | 'arrow-left'
  | 'external';

const PATHS: Record<IconName, ReactNode> = {
  dashboard: <path d="M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z" />,
  upload: <path d="M12 16V4m0 0L7 9m5-5 5 5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />,
  list: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
  audit: <path d="M9 12l2 2 4-4M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />,
  check: <path d="M20 6 9 17l-5-5" />,
  warning: <path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />,
  error: <path d="M12 8v4m0 4h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z" />,
  info: <path d="M12 16v-4m0-4h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z" />,
  file: <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5" />,
  download: <path d="M12 4v12m0 0 5-5m-5 5-5-5M4 19h16" />,
  clock: <path d="M12 7v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z" />,
  close: <path d="M18 6 6 18M6 6l12 12" />,
  search: <path d="m21 21-4.3-4.3M17 11a6 6 0 1 1-12 0 6 6 0 0 1 12 0z" />,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  shield: <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />,
  'arrow-left': <path d="M19 12H5m0 0 6 6m-6-6 6-6" />,
  external: <path d="M14 4h6v6m0-6L10 14M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
};

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}

// ---------------------------------------------------------------- badges

export function StatusBadge({ status }: { status: SubawardStatus }) {
  return <span className={`badge badge-status-${status}`}>{STATUS_LABELS[status]}</span>;
}

const SEV_TEXT: Record<Severity, string> = { PASS: 'Pass', WARNING: 'Warning', ERROR: 'Error' };
const SEV_ICON: Record<Severity, IconName> = { PASS: 'check', WARNING: 'warning', ERROR: 'error' };

export function SeverityBadge({ severity, count, label }: { severity: Severity; count?: number; label?: string }) {
  return (
    <span className={`badge badge-sev-${severity}`}>
      <Icon name={SEV_ICON[severity]} size={13} />
      {label ?? SEV_TEXT[severity]}
      {count !== undefined && count > 0 ? ` (${count})` : ''}
    </span>
  );
}

export function TimelinessBadge({ timeliness, days }: { timeliness: Timeliness; days: number | null }) {
  if (timeliness === 'unknown') return <span className="badge badge-neutral">No due date</span>;
  const cls =
    timeliness === 'overdue' ? 'badge-sev-ERROR' : timeliness === 'due_soon' ? 'badge-sev-WARNING' : 'badge-neutral';
  return (
    <span className={`badge ${cls}`}>
      <Icon name="clock" size={13} />
      {dueLabel(days, timeliness)}
    </span>
  );
}

export function SeverityIcon({ severity }: { severity: Severity }) {
  return <Icon name={SEV_ICON[severity]} size={16} className={`sev-icon sev-${severity}`} />;
}

// ---------------------------------------------------------------- states

export function Spinner({ label = 'Loading…', inline = false }: { label?: string; inline?: boolean }) {
  return (
    <div className={inline ? 'spinner-inline' : 'state-block'} role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="state-block empty-state">
      <Icon name="file" size={28} />
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="state-block error-state" role="alert">
      <Icon name="error" size={28} />
      <h3>We couldn’t load this</h3>
      <p>{message}</p>
      {onRetry && (
        <button className="btn btn-secondary" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Alert({ tone, title, children, onClose }: { tone: 'info' | 'success' | 'warning' | 'error'; title?: string; children?: ReactNode; onClose?: () => void }) {
  const icon: IconName = tone === 'success' ? 'check' : tone === 'info' ? 'info' : tone === 'warning' ? 'warning' : 'error';
  return (
    <div className={`alert alert-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon name={icon} size={18} />
      <div className="alert-body">
        {title && <strong>{title}</strong>}
        {children && <div>{children}</div>}
      </div>
      {onClose && (
        <button className="icon-btn" onClick={onClose} aria-label="Dismiss">
          <Icon name="close" size={16} />
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- confidence

export function ConfidenceMeter({ value, threshold, missing }: { value: number; threshold: number; missing: boolean }) {
  const pct = Math.round(value * 100);
  const tone = missing ? 'missing' : value < threshold ? 'low' : value < 0.9 ? 'medium' : 'high';
  const label = missing ? 'Not found' : `${pct}%`;
  return (
    <div className={`confidence confidence-${tone}`} title={`AI extraction confidence: ${missing ? 'value not found' : `${pct}%`}`}>
      <span className="confidence-label">AI confidence</span>
      <span className="confidence-track" aria-hidden="true">
        <span className="confidence-fill" style={{ width: `${missing ? 0 : pct}%` }} />
      </span>
      <span className="confidence-value">{label}</span>
    </div>
  );
}

// ---------------------------------------------------------------- dialog

export function Dialog({
  open,
  title,
  children,
  onClose,
  footer,
  wide,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  footer: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`dialog ${wide ? 'dialog-wide' : ''}`}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="dialog-header">
        <h2 id={titleId}>{title}</h2>
        <button className="icon-btn" onClick={onClose} aria-label="Close dialog">
          <Icon name="close" />
        </button>
      </div>
      <div className="dialog-body">{children}</div>
      <div className="dialog-footer">{footer}</div>
    </dialog>
  );
}

export function PageHeader({ title, subtitle, actions, eyebrow }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {subtitle && <p className="page-subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}
