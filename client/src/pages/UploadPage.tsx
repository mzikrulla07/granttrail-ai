import { useEffect, useRef, useState, type DragEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { SubawardDetail } from '../api/types';
import { Alert, Icon, PageHeader } from '../components/ui';
import { formatBytes } from '../lib/format';
import { checkFileBasics, hasPdfSignature } from '../lib/uploadValidation';
import { useSession } from '../session';

type Phase = 'idle' | 'uploading' | 'success';

/** Map server error codes to guidance a grants specialist can act on. */
function friendlyUploadError(e: unknown): { text: string; existingId?: string } {
  if (!(e instanceof ApiError)) return { text: 'The upload failed. Please try again.' };
  switch (e.code) {
    case 'DUPLICATE_DOCUMENT': {
      const id = (e.details as { subawardId?: string } | undefined)?.subawardId;
      return { text: 'This exact agreement has already been uploaded, so a second record was not created.', existingId: id };
    }
    case 'NO_TEXT':
    case 'PDF_ENCRYPTED':
    case 'PDF_UNREADABLE':
    case 'NOT_A_PDF':
    case 'FILE_TOO_LARGE':
    case 'RATE_LIMITED':
    case 'FORBIDDEN':
    case 'NETWORK':
      return { text: e.message };
    default:
      return { text: e.status >= 500 || e.status === 0 ? e.message : `The agreement could not be processed. ${e.message}` };
  }
}

export function UploadPage() {
  const { health, can } = useSession();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<{ text: string; existingId?: string } | null>(null);
  const [result, setResult] = useState<SubawardDetail | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const maxMb = health?.limits.maxUploadMb ?? 10;

  useEffect(() => {
    if (phase !== 'uploading') return;
    setElapsed(0);
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  useEffect(() => {
    if (phase !== 'success' || !result) return;
    const t = setTimeout(() => navigate(`/subawards/${result.id}`), 1600);
    return () => clearTimeout(t);
  }, [phase, result, navigate]);

  if (!can('subaward:upload')) {
    return (
      <>
        <PageHeader title="Upload Agreement" />
        <Alert tone="info" title="View-only access">
          Your role can view dashboards and records but cannot upload agreements. Switch to a Grants Specialist to upload.
        </Alert>
      </>
    );
  }

  const choose = async (f: File | undefined | null) => {
    setError(null);
    if (!f) return;
    const basic = checkFileBasics(f, maxMb);
    if (!basic.ok) {
      setFile(null);
      setError({ text: basic.message! });
      return;
    }
    if (!(await hasPdfSignature(f))) {
      setFile(null);
      setError({ text: 'This file has a .pdf name but is not a valid PDF document. Re-export the agreement as PDF and try again.' });
      return;
    }
    setFile(f);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (phase === 'uploading') return;
    if (e.dataTransfer.files.length > 1) {
      setError({ text: 'Upload one agreement at a time.' });
      return;
    }
    void choose(e.dataTransfer.files[0]);
  };

  const submit = async () => {
    if (!file) return;
    setPhase('uploading');
    setError(null);
    try {
      const sub = await api.upload(file);
      setResult(sub);
      setPhase('success');
    } catch (e) {
      setError(friendlyUploadError(e));
      setPhase('idle');
    }
  };

  const aiLabel = health?.demoMode ? 'Simulating AI extraction (demo mode)' : 'Analyzing with Claude';
  const steps = ['Uploading agreement securely', 'Extracting text from PDF', aiLabel, 'Running validation rules'];
  const activeStep = Math.min(steps.length - 1, Math.floor(elapsed / 1.5));

  return (
    <>
      <PageHeader
        title="Upload Agreement"
        subtitle="Upload a signed subaward agreement. GrantTrail extracts the reporting fields for you to review — nothing is approved automatically."
      />

      <div className="upload-layout">
        <section className="panel upload-panel">
          {phase === 'success' && result ? (
            <div className="upload-success" role="status">
              <div className="success-icon">
                <Icon name="check" size={28} />
              </div>
              <h2>Agreement uploaded</h2>
              <p>
                <strong>{result.document.filename}</strong> was processed. {result.fields.filter((f) => f.value).length} of 6 fields
                were extracted{result.validation.blockingErrorCount > 0 ? `, with ${result.validation.blockingErrorCount} validation error(s) to resolve` : ''}.
              </p>
              <p className="muted">Opening the review screen…</p>
              <Link className="btn btn-primary" to={`/subawards/${result.id}`}>
                Review now
              </Link>
            </div>
          ) : (
            <>
              <div
                className={`dropzone ${dragging ? 'dragging' : ''} ${phase === 'uploading' ? 'busy' : ''}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (phase !== 'uploading') setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
                onClick={() => phase !== 'uploading' && inputRef.current?.click()}
                onKeyDown={(e) => {
                  if ((e.key === 'Enter' || e.key === ' ') && phase !== 'uploading') {
                    e.preventDefault();
                    inputRef.current?.click();
                  }
                }}
                role="button"
                tabIndex={0}
                aria-label="Choose a PDF agreement to upload, or drag and drop it here"
                aria-disabled={phase === 'uploading'}
              >
                <Icon name="upload" size={34} />
                <p className="dropzone-title">Drag and drop a PDF agreement here</p>
                <p className="muted">
                  or <span className="link-like">browse your files</span> · PDF only · up to {maxMb} MB
                </p>
                <input
                  ref={inputRef}
                  type="file"
                  accept="application/pdf,.pdf"
                  hidden
                  onChange={(e) => {
                    void choose(e.target.files?.[0]);
                    e.target.value = '';
                  }}
                />
              </div>

              {error && (
                <Alert tone="error" title="Upload not completed" onClose={() => setError(null)}>
                  {error.text}{' '}
                  {error.existingId && (
                    <Link to={`/subawards/${error.existingId}`}>Open the existing record →</Link>
                  )}
                </Alert>
              )}

              {file && (
                <div className="file-card">
                  <Icon name="file" size={22} />
                  <div className="file-meta">
                    <strong>{file.name}</strong>
                    <span className="muted">{formatBytes(file.size)} · PDF</span>
                  </div>
                  {phase !== 'uploading' && (
                    <button className="btn btn-link" onClick={() => setFile(null)}>
                      Remove
                    </button>
                  )}
                </div>
              )}

              {phase === 'uploading' && (
                <div className="progress-steps" role="status" aria-live="polite">
                  <div className="progress-head">
                    <span className="spinner" aria-hidden="true" />
                    <strong>Processing agreement…</strong>
                    <span className="muted">{elapsed}s</span>
                  </div>
                  <ol>
                    {steps.map((s, i) => (
                      <li key={s} className={i < activeStep ? 'done' : i === activeStep ? 'active' : ''}>
                        {s}
                      </li>
                    ))}
                  </ol>
                </div>
              )}

              <div className="upload-actions">
                <Link className="btn btn-secondary" to="/">
                  Cancel
                </Link>
                <button className="btn btn-primary" onClick={submit} disabled={!file || phase === 'uploading'}>
                  {phase === 'uploading' ? 'Processing…' : 'Upload and extract'}
                </button>
              </div>
            </>
          )}
        </section>

        <aside className="panel side-help">
          <h2>What happens next</h2>
          <ol className="how-list">
            <li>
              <strong>AI extracts.</strong> {health?.demoMode ? 'The demo simulator' : 'Claude'} reads the agreement text on the server and
              returns each field with a confidence score and the exact source excerpt.
            </li>
            <li>
              <strong>Code validates.</strong> Deterministic rules check the UEI format, amount, award date, reporting threshold, and
              deadline.
            </li>
            <li>
              <strong>You approve.</strong> You review every field side-by-side with the source, correct anything wrong, and approve.
              Every action is recorded in the audit trail.
            </li>
          </ol>
          {health?.demoMode && (
            <div className="hint-box">
              <strong>Sample agreements</strong>
              <p>
                Fictional sample PDFs are in the project’s <code>samples/</code> folder: a clean agreement, one with an invalid UEI, and
                one with missing fields.
              </p>
            </div>
          )}
          <p className="muted small">
            Files are verified as PDF by content, stored under a random server-generated name, and never shared with third parties
            other than the configured AI provider.
          </p>
        </aside>
      </div>
    </>
  );
}
