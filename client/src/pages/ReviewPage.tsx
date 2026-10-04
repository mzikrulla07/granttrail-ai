import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useBlocker, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, saveBlob } from '../api/client';
import {
  FIELD_ORDER,
  type AuditEvent,
  type FieldDto,
  type FieldName,
  type SubawardDetail,
  type ValidationCheck,
  type ValidationReport,
} from '../api/types';
import {
  Alert,
  ConfidenceMeter,
  Dialog,
  ErrorState,
  Icon,
  SeverityBadge,
  SeverityIcon,
  Spinner,
  StatusBadge,
  TimelinessBadge,
} from '../components/ui';
import { describeEvent, EVENT_LABELS, formatBytes, formatCurrency, formatDate, formatDateTime } from '../lib/format';
import { useSession } from '../session';

type Draft = Record<FieldName, string>;

const HINTS: Partial<Record<FieldName, string>> = {
  uei: '12 characters, letters and digits (never I or O).',
  amount: 'Total federal amount obligated by this agreement, e.g. 185000.00',
  awardDate: 'Date the subaward was made, e.g. 2026-08-14 or August 14, 2026',
  placeOfPerformance: 'City, two-letter state, and ZIP code',
};

const toDraft = (fields: FieldDto[]): Draft =>
  Object.fromEntries(FIELD_ORDER.map((f) => [f, fields.find((x) => x.name === f)?.value ?? ''])) as Draft;

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Locate an excerpt in the document text, tolerant of whitespace/line-break differences. */
function findExcerpt(text: string, excerpt: string): [number, number] | null {
  const words = excerpt.replace(/…$/, '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const re = new RegExp(words.map(escapeRegExp).join('\\s+'), 'i');
  const m = re.exec(text);
  return m ? [m.index, m.index + m[0].length] : null;
}

function HighlightedText({ text, fields, active }: { text: string; fields: FieldDto[]; active: FieldName | null }) {
  const segments = useMemo(() => {
    const ranges: { start: number; end: number; field: FieldName }[] = [];
    for (const f of fields) {
      if (!f.sourceExcerpt) continue;
      const r = findExcerpt(text, f.sourceExcerpt);
      if (r && !ranges.some((x) => r[0] < x.end && r[1] > x.start)) ranges.push({ start: r[0], end: r[1], field: f.name });
    }
    ranges.sort((a, b) => a.start - b.start);
    const out: ReactNode[] = [];
    let pos = 0;
    ranges.forEach((r, i) => {
      if (r.start > pos) out.push(text.slice(pos, r.start));
      out.push(
        <mark key={i} data-field={r.field} className={r.field === active ? 'active' : undefined}>
          {text.slice(r.start, r.end)}
        </mark>,
      );
      pos = r.end;
    });
    out.push(text.slice(pos));
    return out;
  }, [text, fields, active]);
  return <pre className="doc-text">{segments}</pre>;
}

function CheckList({ checks, showPass = true }: { checks: ValidationCheck[]; showPass?: boolean }) {
  const order = { ERROR: 0, WARNING: 1, PASS: 2 } as const;
  const sorted = [...checks].filter((c) => showPass || c.severity !== 'PASS').sort((a, b) => order[a.severity] - order[b.severity]);
  if (sorted.length === 0) return null;
  return (
    <ul className="check-list">
      {sorted.map((c, i) => (
        <li key={`${c.code}-${i}`} className={`check check-${c.severity}`}>
          <SeverityIcon severity={c.severity} />
          <span>{c.message}</span>
        </li>
      ))}
    </ul>
  );
}

export function ReviewPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { can, health, me } = useSession();

  const [detail, setDetail] = useState<SubawardDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [preview, setPreview] = useState<ValidationReport | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [active, setActive] = useState<FieldName | null>(null);
  const [tab, setTab] = useState<'text' | 'pdf'>('text');
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'save' | 'approve' | 'export' | 'report'>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error' | 'info'; title?: string; text: ReactNode } | null>(null);
  const [approveOpen, setApproveOpen] = useState(false);
  const [attested, setAttested] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reference, setReference] = useState('');
  const [history, setHistory] = useState<AuditEvent[] | null>(null);
  const docRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const d = await api.get(id);
      setDetail(d);
      setDraft(toDraft(d.fields));
      setPreview(null);
      if (can('audit:read')) api.audit({ subawardId: id, limit: 100 }).then((r) => setHistory(r.items)).catch(() => setHistory([]));
    } catch (e) {
      setLoadError(e instanceof ApiError ? e.message : 'This record could not be loaded.');
    }
  }, [id, can]);

  useEffect(() => {
    void load();
  }, [load, me?.email]);

  const editable = !!detail && detail.status === 'awaiting_review' && can('subaward:edit');

  const dirtyFields = useMemo(() => {
    if (!detail || !draft) return {} as Partial<Record<FieldName, string | null>>;
    const out: Partial<Record<FieldName, string | null>> = {};
    for (const f of detail.fields) {
      if (norm(draft[f.name]) !== norm(f.value)) out[f.name] = norm(draft[f.name]) || null;
    }
    return out;
  }, [detail, draft]);
  const dirtyCount = Object.keys(dirtyFields).length;
  const isDirty = dirtyCount > 0;

  // Live deterministic validation of unsaved edits (server-side rules, no AI).
  useEffect(() => {
    if (!detail || !isDirty) {
      setPreview(null);
      return;
    }
    setPreviewing(true);
    const t = setTimeout(() => {
      api
        .previewValidation(detail.id, dirtyFields)
        .then(setPreview)
        .catch(() => undefined)
        .finally(() => setPreviewing(false));
    }, 350);
    return () => clearTimeout(t);
  }, [detail, dirtyFields, isDirty]);

  const report: ValidationReport | null = preview ?? detail?.validation ?? null;

  // Unsaved-changes protection
  const blocker = useBlocker(({ currentLocation, nextLocation }) => isDirty && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => {
    if (!isDirty) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [isDirty]);

  // PDF preview (fetched with auth headers, shown via blob URL)
  useEffect(() => {
    if (tab !== 'pdf' || pdfUrl || !detail) return;
    let url: string | null = null;
    api
      .documentBlob(detail.id)
      .then((blob) => {
        url = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
        setPdfUrl(url);
      })
      .catch((e) => setPdfError(e instanceof ApiError ? e.message : 'The PDF could not be displayed.'));
  }, [tab, pdfUrl, detail]);
  useEffect(() => () => void (pdfUrl && URL.revokeObjectURL(pdfUrl)), [pdfUrl]);

  const showInDocument = (f: FieldName) => {
    setActive(f);
    setTab('text');
    requestAnimationFrame(() => {
      const el = docRef.current?.querySelector(`mark[data-field="${f}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  };

  const saveDraft = async () => {
    if (!detail || !isDirty) return;
    setBusy('save');
    setNotice(null);
    try {
      const d = await api.saveDraft(detail.id, dirtyFields);
      setDetail(d);
      setDraft(toDraft(d.fields));
      setPreview(null);
      setNotice({ tone: 'success', text: `Draft saved. ${dirtyCount} field change${dirtyCount === 1 ? '' : 's'} recorded in the audit trail.` });
      api.audit({ subawardId: id, limit: 100 }).then((r) => setHistory(r.items)).catch(() => undefined);
    } catch (e) {
      setNotice({ tone: 'error', title: 'Draft not saved', text: e instanceof ApiError ? e.message : 'Please try again.' });
    } finally {
      setBusy(null);
    }
  };

  const approve = async () => {
    if (!detail) return;
    setBusy('approve');
    try {
      const d = await api.approve(detail.id, dirtyFields);
      setDetail(d);
      setDraft(toDraft(d.fields));
      setPreview(null);
      setApproveOpen(false);
      setAttested(false);
      setNotice({ tone: 'success', title: 'Record approved', text: 'The approval was written to the audit trail. This record is now locked and ready to export.' });
      api.audit({ subawardId: id, limit: 100 }).then((r) => setHistory(r.items)).catch(() => undefined);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      setApproveOpen(false);
      if (e instanceof ApiError && e.code === 'APPROVAL_BLOCKED') {
        const reasons = (e.details as { reasons?: string[] } | undefined)?.reasons ?? [];
        setNotice({
          tone: 'error',
          title: 'Approval blocked by validation',
          text: (
            <ul className="plain-list">
              {reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          ),
        });
      } else {
        setNotice({ tone: 'error', title: 'Approval failed', text: e instanceof ApiError ? e.message : 'Please try again.' });
      }
    } finally {
      setBusy(null);
    }
  };

  const exportCsv = async () => {
    if (!detail) return;
    setBusy('export');
    try {
      const { blob, filename } = await api.exportOne(detail.id);
      saveBlob(blob, filename);
      setDetail(await api.get(detail.id));
      setNotice({ tone: 'success', text: `Export generated: ${filename}` });
      api.audit({ subawardId: id, limit: 100 }).then((r) => setHistory(r.items)).catch(() => undefined);
    } catch (e) {
      setNotice({ tone: 'error', title: 'Export failed', text: e instanceof ApiError ? e.message : 'Please try again.' });
    } finally {
      setBusy(null);
    }
  };

  const markReported = async () => {
    if (!detail) return;
    setBusy('report');
    try {
      const d = await api.markReported(detail.id, reference.trim() || undefined);
      setDetail(d);
      setReportOpen(false);
      setReference('');
      setNotice({ tone: 'success', text: 'Record marked as reported.' });
      api.audit({ subawardId: id, limit: 100 }).then((r) => setHistory(r.items)).catch(() => undefined);
    } catch (e) {
      setReportOpen(false);
      setNotice({ tone: 'error', text: e instanceof ApiError ? e.message : 'Please try again.' });
    } finally {
      setBusy(null);
    }
  };

  if (loadError) {
    return (
      <>
        <Link className="back-link" to="/subawards">
          <Icon name="arrow-left" size={16} /> Back to subawards
        </Link>
        <ErrorState message={loadError} onRetry={load} />
      </>
    );
  }
  if (!detail || !draft || !report) return <Spinner label="Loading record…" />;

  const threshold = health?.rules.lowConfidenceThreshold ?? 0.75;
  const recordChecks = report.checks.filter((c) => c.field === null || c.code === 'REPORTING_THRESHOLD');
  const title = draft.subrecipientName || detail.subrecipientName || 'Untitled agreement';
  const n = report.normalized;

  return (
    <div className="review-page">
      <Link className="back-link" to="/subawards">
        <Icon name="arrow-left" size={16} /> Subawards
      </Link>

      <header className="review-header">
        <div>
          <h1>{title}</h1>
          <div className="review-meta">
            <StatusBadge status={detail.status} />
            <SeverityBadge severity={report.status} label={report.status === 'PASS' ? 'Validation passed' : report.status === 'WARNING' ? `${report.warningCount} warning${report.warningCount === 1 ? '' : 's'}` : `${report.blockingErrorCount} blocking error${report.blockingErrorCount === 1 ? '' : 's'}`} />
            {detail.status !== 'reported' && <TimelinessBadge timeliness={report.timeliness} days={report.daysUntilDue} />}
            <span className="muted small">Report due {formatDate(report.dueDate)}</span>
          </div>
        </div>
        {detail.status !== 'awaiting_review' && (
          <div className="page-actions">
            {can('subaward:export') && (
              <button className="btn btn-secondary" onClick={exportCsv} disabled={busy !== null}>
                <Icon name="download" size={16} />
                {busy === 'export' ? 'Exporting…' : 'Export CSV'}
              </button>
            )}
            {detail.status === 'approved' && can('subaward:report') && (
              <button className="btn btn-primary" onClick={() => setReportOpen(true)} disabled={busy !== null}>
                Mark as reported
              </button>
            )}
          </div>
        )}
      </header>

      {notice && (
        <Alert tone={notice.tone} title={notice.title} onClose={() => setNotice(null)}>
          {notice.text}
        </Alert>
      )}

      {detail.extraction.status === 'failed' && (
        <Alert tone="warning" title="AI extraction was unavailable">
          No values could be extracted automatically. Enter each field from the agreement on the left. The reason is recorded under
          Record history below.
        </Alert>
      )}

      {detail.approval && (
        <div className="approval-banner">
          <Icon name="shield" size={20} />
          <div>
            <strong>
              Approved by {detail.approval.approvedBy} on {formatDateTime(detail.approval.approvedAt)}
            </strong>
            <span>
              {detail.status === 'reported'
                ? `Marked as reported ${formatDateTime(detail.reportedAt)}.`
                : detail.exportedAt
                  ? `Last exported ${formatDateTime(detail.exportedAt)}. Mark as reported once submitted.`
                  : 'Ready to export for reporting.'}{' '}
              Approved values are locked.
            </span>
          </div>
        </div>
      )}

      {editable && (
        <div className={`validation-summary sev-${report.status}`} role="status" aria-live="polite">
          <SeverityIcon severity={report.status} />
          <div>
            {report.status === 'ERROR' ? (
              <strong>
                {report.blockingErrorCount} blocking error{report.blockingErrorCount === 1 ? '' : 's'} must be resolved before this record
                can be approved.
              </strong>
            ) : report.status === 'WARNING' ? (
              <strong>No blocking errors. Review {report.warningCount} warning{report.warningCount === 1 ? '' : 's'} before approving.</strong>
            ) : (
              <strong>All validation checks passed.</strong>
            )}
            <span className="muted small">
              {previewing ? ' Re-checking…' : isDirty ? ' Showing results for your unsaved edits.' : ''} Validation is performed by deterministic rules, not by AI.
            </span>
          </div>
        </div>
      )}

      <div className="review-grid">
        {/* LEFT — source document */}
        <section className="panel doc-panel" aria-label="Source agreement">
          <div className="panel-header">
            <h2>Source agreement</h2>
          </div>
          <dl className="doc-meta">
            <div>
              <dt>File</dt>
              <dd className="break">{detail.document.filename}</dd>
            </div>
            <div>
              <dt>Size</dt>
              <dd>
                {formatBytes(detail.document.sizeBytes)} · {detail.document.pageCount ?? '?'} page{detail.document.pageCount === 1 ? '' : 's'}
              </dd>
            </div>
            <div>
              <dt>Uploaded</dt>
              <dd>
                {formatDateTime(detail.document.uploadedAt)} by {detail.document.uploadedBy}
              </dd>
            </div>
            <div>
              <dt>Extraction</dt>
              <dd>
                {detail.extraction.mode === 'demo' ? (
                  <span className="badge badge-demo">Demo simulator</span>
                ) : (
                  <span className="badge badge-neutral">Claude · {detail.extraction.model}</span>
                )}
              </dd>
            </div>
            <div>
              <dt>SHA-256</dt>
              <dd className="mono small" title={detail.document.sha256}>
                {detail.document.sha256.slice(0, 16)}…
              </dd>
            </div>
          </dl>
          <div className="doc-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'text'} className={tab === 'text' ? 'active' : ''} onClick={() => setTab('text')}>
              Extracted text
            </button>
            <button role="tab" aria-selected={tab === 'pdf'} className={tab === 'pdf' ? 'active' : ''} onClick={() => setTab('pdf')}>
              Original PDF
            </button>
          </div>
          <div
            className="doc-view"
            ref={docRef}
            tabIndex={0}
            role="region"
            aria-label={tab === 'text' ? 'Extracted agreement text' : 'Original PDF'}
          >
            {tab === 'text' ? (
              <>
                <p className="doc-legend">
                  <mark>Highlighted</mark> passages are the source excerpts for extracted fields. Use “Show in document” on a field to jump to
                  it.
                </p>
                <HighlightedText text={detail.document.text} fields={detail.fields} active={active} />
              </>
            ) : pdfError ? (
              <ErrorState message={pdfError} />
            ) : pdfUrl ? (
              <iframe className="pdf-frame" src={pdfUrl} title={`PDF: ${detail.document.filename}`} />
            ) : (
              <Spinner label="Loading PDF…" />
            )}
          </div>
        </section>

        {/* RIGHT — extracted fields */}
        <section className="fields-col" aria-label="Extracted fields">
          <div className="panel">
            <div className="panel-header">
              <h2>Extracted fields</h2>
              <span className="muted small">{editable ? 'Correct any value that does not match the agreement.' : 'Read-only'}</span>
            </div>
            <div className="field-list">
              {detail.fields.map((f) => {
                const status = report.fieldStatus[f.name];
                const checks = report.checks.filter((c) => c.field === f.name && c.code !== 'REPORTING_THRESHOLD');
                const edited = f.name in dirtyFields;
                const missing = !f.aiValue;
                const low = !missing && f.confidence < threshold && !f.isHumanEdited;
                const interpreted =
                  f.name === 'amount' && n.amount
                    ? formatCurrency(n.amount)
                    : f.name === 'awardDate' && n.awardDate
                      ? formatDate(n.awardDate)
                      : f.name === 'uei' && n.uei && n.uei !== norm(draft.uei)
                        ? n.uei
                        : null;
                const inputId = `field-${f.name}`;
                return (
                  <article
                    key={f.name}
                    className={`field-card sev-${status} ${active === f.name ? 'is-active' : ''} ${low ? 'is-low' : ''}`}
                    onFocus={() => setActive(f.name)}
                  >
                    <div className="field-head">
                      <label htmlFor={inputId} className="field-label">
                        {f.label}
                      </label>
                      <SeverityBadge severity={status} />
                    </div>
                    <ConfidenceMeter value={f.confidence} threshold={threshold} missing={missing} />
                    {f.name === 'projectDescription' ? (
                      <textarea
                        id={inputId}
                        rows={4}
                        value={draft[f.name]}
                        readOnly={!editable}
                        maxLength={5000}
                        aria-invalid={status === 'ERROR'}
                        onChange={(e) => setDraft({ ...draft, [f.name]: e.target.value })}
                      />
                    ) : (
                      <input
                        id={inputId}
                        type="text"
                        value={draft[f.name]}
                        readOnly={!editable}
                        maxLength={500}
                        placeholder={missing && editable ? 'Not found in document — enter manually' : undefined}
                        aria-invalid={status === 'ERROR'}
                        aria-describedby={HINTS[f.name] ? `${inputId}-hint` : undefined}
                        className={f.name === 'uei' ? 'mono' : undefined}
                        onChange={(e) => setDraft({ ...draft, [f.name]: e.target.value })}
                      />
                    )}
                    {editable && HINTS[f.name] && (
                      <div id={`${inputId}-hint`} className="field-hint">
                        {HINTS[f.name]}
                        {interpreted && <span className="interpreted"> · Interpreted as <strong>{interpreted}</strong></span>}
                      </div>
                    )}
                    {(edited || f.isHumanEdited) && (
                      <div className="edit-note">
                        <Icon name="info" size={14} />
                        {edited ? 'Unsaved change.' : `Edited by ${f.editedBy ?? 'reviewer'} ${formatDateTime(f.editedAt)}.`} AI extracted:{' '}
                        <span className="mono">{f.aiValue ?? '(not found)'}</span>
                        {editable && norm(draft[f.name]) !== norm(f.aiValue) && (
                          <button className="btn btn-link btn-xs" onClick={() => setDraft({ ...draft, [f.name]: f.aiValue ?? '' })}>
                            Revert to AI value
                          </button>
                        )}
                      </div>
                    )}
                    <div className="excerpt">
                      <div className="excerpt-head">
                        <span>Source excerpt</span>
                        {f.sourceExcerpt && (
                          <button className="btn btn-link btn-xs" onClick={() => showInDocument(f.name)}>
                            Show in document
                          </button>
                        )}
                      </div>
                      {f.sourceExcerpt ? (
                        <blockquote>{f.sourceExcerpt}</blockquote>
                      ) : (
                        <p className="excerpt-missing">No supporting text was found in the agreement. Human review required.</p>
                      )}
                    </div>
                    <CheckList checks={checks} />
                  </article>
                );
              })}
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <h2>Reporting checks</h2>
            </div>
            <CheckList checks={recordChecks} />
          </div>

          {editable && (
            <div className="action-bar">
              <div className="action-bar-status">
                {isDirty ? (
                  <span className="dirty-dot">{dirtyCount} unsaved change{dirtyCount === 1 ? '' : 's'}</span>
                ) : (
                  <span className="muted">No unsaved changes</span>
                )}
                {!report.canApprove && (
                  <span className="blocking-note">
                    Approval blocked: resolve {report.blockingErrorCount} error{report.blockingErrorCount === 1 ? '' : 's'}
                  </span>
                )}
              </div>
              <div className="action-bar-buttons">
                <button className="btn btn-secondary" onClick={() => navigate('/subawards')} disabled={busy !== null}>
                  Cancel
                </button>
                <button className="btn btn-secondary" onClick={saveDraft} disabled={!isDirty || busy !== null}>
                  {busy === 'save' ? 'Saving…' : 'Save Draft'}
                </button>
                <button
                  className="btn btn-primary"
                  onClick={() => setApproveOpen(true)}
                  disabled={!report.canApprove || previewing || busy !== null || !can('subaward:approve')}
                  title={!report.canApprove ? 'Resolve all blocking validation errors before approving' : undefined}
                >
                  Approve
                </button>
              </div>
            </div>
          )}
        </section>
      </div>

      {history && (
        <section className="panel history">
          <div className="panel-header">
            <h2>Record history</h2>
            <Link className="btn btn-link" to={`/audit?subawardId=${detail.id}`}>
              Open in Audit Trail →
            </Link>
          </div>
          <ol className="timeline">
            {history.map((e) => (
              <li key={e.id}>
                <span className={`tl-dot tl-${e.eventType}`} aria-hidden="true" />
                <div>
                  <div className="tl-head">
                    <strong>{EVENT_LABELS[e.eventType] ?? e.eventType}</strong>
                    <span className="muted small">
                      {formatDateTime(e.timestamp)} · {e.actorName}
                    </span>
                  </div>
                  <div className="tl-body">{describeEvent(e.eventType, e.details)}</div>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* Approval confirmation */}
      <Dialog
        open={approveOpen}
        wide
        title="Approve subaward record"
        onClose={() => {
          setApproveOpen(false);
          setAttested(false);
        }}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setApproveOpen(false)} disabled={busy === 'approve'}>
              Go back
            </button>
            <button className="btn btn-primary" onClick={approve} disabled={!attested || busy === 'approve'}>
              {busy === 'approve' ? 'Approving…' : 'Approve record'}
            </button>
          </>
        }
      >
        <p>You are approving the following values for federal subaward reporting. Approved records are locked.</p>
        <table className="confirm-table">
          <tbody>
            <tr>
              <th>Subrecipient</th>
              <td>{n.subrecipientName}</td>
            </tr>
            <tr>
              <th>UEI</th>
              <td className="mono">{n.uei}</td>
            </tr>
            <tr>
              <th>Amount</th>
              <td>{formatCurrency(n.amount)}</td>
            </tr>
            <tr>
              <th>Award date</th>
              <td>{formatDate(n.awardDate)}</td>
            </tr>
            <tr>
              <th>Report due</th>
              <td>{formatDate(report.dueDate)}</td>
            </tr>
            <tr>
              <th>Place of performance</th>
              <td>{n.placeOfPerformance}</td>
            </tr>
            <tr>
              <th>Description</th>
              <td>{n.projectDescription}</td>
            </tr>
          </tbody>
        </table>
        {isDirty && <Alert tone="info">Your {dirtyCount} unsaved change{dirtyCount === 1 ? '' : 's'} will be saved and audited as part of this approval.</Alert>}
        {report.warningCount > 0 && (
          <div className="ack-warnings">
            <strong>You are acknowledging {report.warningCount} warning{report.warningCount === 1 ? '' : 's'}:</strong>
            <CheckList checks={report.checks.filter((c) => c.severity === 'WARNING')} />
          </div>
        )}
        <label className="attest">
          <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} />
          <span>{detail.attestationText}</span>
        </label>
      </Dialog>

      {/* Mark reported confirmation */}
      <Dialog
        open={reportOpen}
        title="Mark as reported"
        onClose={() => setReportOpen(false)}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setReportOpen(false)}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={markReported} disabled={busy === 'report'}>
              {busy === 'report' ? 'Saving…' : 'Confirm reported'}
            </button>
          </>
        }
      >
        <p>
          Confirm that this subaward has been submitted through SAM.gov. GrantTrail does not submit reports itself — this records the
          status change in the audit trail.
        </p>
        <label className="form-field">
          <span>Submission reference (optional)</span>
          <input type="text" maxLength={200} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. confirmation number" />
        </label>
      </Dialog>

      {/* Unsaved changes guard (Cancel / navigation) */}
      <Dialog
        open={blocker.state === 'blocked'}
        title="Discard unsaved changes?"
        onClose={() => blocker.reset?.()}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => blocker.reset?.()}>
              Keep editing
            </button>
            <button className="btn btn-danger" onClick={() => blocker.proceed?.()}>
              Discard changes
            </button>
          </>
        }
      >
        <p>
          You have {dirtyCount} unsaved change{dirtyCount === 1 ? '' : 's'}. If you leave now they will be lost. Use <strong>Save Draft</strong>{' '}
          to keep them.
        </p>
      </Dialog>
    </div>
  );
}
