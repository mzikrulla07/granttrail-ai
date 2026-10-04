import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError, saveBlob } from '../api/client';
import type { ListFilter } from '../api/types';
import { FilterTabs, SubawardTable } from '../components/SubawardTable';
import { Alert, ErrorState, Icon, PageHeader, Spinner } from '../components/ui';
import { formatCurrency, formatDate } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { useSession } from '../session';

export function DashboardPage() {
  const { can, me } = useSession();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<ListFilter>('all');
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [exporting, setExporting] = useState(false);

  const dash = useAsync(() => api.dashboard(), [me?.email]);
  const list = useAsync(() => api.list(filter), [filter, me?.email]);

  const t = dash.data?.totals;
  const cards: { key: ListFilter; label: string; value: string | number; hint: string; tone: string }[] = t
    ? [
        { key: 'all', label: 'Total Subawards', value: t.total, hint: `${formatCurrency(t.totalAmount, { compact: true })} passed through`, tone: 'neutral' },
        { key: 'due_soon', label: 'Due Soon', value: t.dueSoon, hint: `Report due within ${dash.data!.rules.dueSoonDays} days`, tone: 'warning' },
        { key: 'overdue', label: 'Overdue', value: t.overdue, hint: t.overdue ? 'Past the reporting deadline' : 'No missed deadlines', tone: 'error' },
        { key: 'awaiting_review', label: 'Awaiting Review', value: t.awaitingReview, hint: `${t.withErrors} with blocking errors`, tone: 'info' },
        { key: 'approved', label: 'Approved / Reported', value: t.approvedOrReported, hint: `${t.approved} approved · ${t.reported} reported`, tone: 'success' },
      ]
    : [];

  const exportApproved = async () => {
    setExporting(true);
    setNotice(null);
    try {
      const { blob, filename } = await api.exportApproved();
      saveBlob(blob, filename);
      setNotice({ tone: 'success', text: `Export generated: ${filename}. The export was recorded in the audit trail.` });
      list.reload();
    } catch (e) {
      setNotice({ tone: 'error', text: e instanceof ApiError ? e.message : 'The export could not be generated.' });
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="Riverbend Housing Coalition"
        title="Subaward Reporting Dashboard"
        subtitle={
          dash.data?.nextDeadline
            ? `Next reporting deadline: ${formatDate(dash.data.nextDeadline)}. Reports are due by the end of the month following each award.`
            : 'Federal subaward reporting status across all partner agencies.'
        }
        actions={
          <>
            {can('subaward:export') && (
              <button className="btn btn-secondary" onClick={exportApproved} disabled={exporting}>
                <Icon name="download" size={16} />
                {exporting ? 'Exporting…' : 'Export approved (CSV)'}
              </button>
            )}
            {can('subaward:upload') && (
              <Link className="btn btn-primary" to="/upload">
                <Icon name="upload" size={16} />
                Upload Agreement
              </Link>
            )}
          </>
        }
      />

      {notice && (
        <Alert tone={notice.tone} onClose={() => setNotice(null)}>
          {notice.text}
        </Alert>
      )}

      {dash.error ? (
        <ErrorState message={dash.error} onRetry={dash.reload} />
      ) : !t ? (
        <Spinner label="Loading dashboard…" />
      ) : (
        <section className="summary-grid" aria-label="Summary">
          {cards.map((c) => (
            <button
              key={c.label}
              className={`summary-card tone-${c.tone} ${filter === c.key ? 'selected' : ''}`}
              onClick={() => setFilter(c.key)}
              aria-pressed={filter === c.key}
            >
              <span className="summary-label">{c.label}</span>
              <span className="summary-value">{c.value}</span>
              <span className="summary-hint">{c.hint}</span>
            </button>
          ))}
        </section>
      )}

      <section className="panel">
        <div className="panel-header">
          <h2>Subawards</h2>
          <FilterTabs value={filter} onChange={setFilter} />
        </div>
        {list.error ? (
          <ErrorState message={list.error} onRetry={list.reload} />
        ) : list.loading && !list.data ? (
          <Spinner label="Loading subawards…" />
        ) : (
          <SubawardTable items={list.data ?? []} filter={filter} canEdit={can('subaward:edit')} />
        )}
        {filter !== 'all' && list.data && list.data.length > 0 && (
          <div className="panel-footer">
            <button className="btn btn-link" onClick={() => navigate(`/subawards?filter=${filter}`)}>
              Open in Subawards →
            </button>
          </div>
        )}
      </section>
    </>
  );
}
