import { Fragment, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { EmptyState, ErrorState, PageHeader, Spinner } from '../components/ui';
import { describeEvent, EVENT_LABELS, formatDateTime } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { useSession } from '../session';

const PAGE_SIZE = 50;

export function AuditPage() {
  const { me, can } = useSession();
  const [params, setParams] = useSearchParams();
  const subawardId = params.get('subawardId') ?? undefined;
  const eventType = params.get('eventType') ?? '';
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);

  const q = useAsync(
    () => api.audit({ subawardId, eventType: eventType || undefined, limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
    [subawardId, eventType, page, me?.email],
  );

  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
    setPage(0);
  };

  if (!can('audit:read')) return <ErrorState message="Your role cannot view the audit trail." />;

  const total = q.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <PageHeader
        title="Audit Trail"
        subtitle="Append-only record of every upload, extraction, edit, validation, approval, export, and status change. Entries cannot be modified or deleted."
      />
      <section className="panel">
        <div className="panel-header panel-header-wrap">
          <label className="inline-field">
            <span>Event type</span>
            <select value={eventType} onChange={(e) => setParam('eventType', e.target.value || null)}>
              <option value="">All events</option>
              {Object.entries(EVENT_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          {subawardId && (
            <span className="filter-chip">
              Filtered to one record
              <button className="btn btn-link btn-xs" onClick={() => setParam('subawardId', null)}>
                Clear
              </button>
            </span>
          )}
          <span className="muted small">{total} event{total === 1 ? '' : 's'}</span>
        </div>

        {q.error ? (
          <ErrorState message={q.error} onRetry={q.reload} />
        ) : q.loading && !q.data ? (
          <Spinner label="Loading audit events…" />
        ) : !q.data || q.data.items.length === 0 ? (
          <EmptyState title="No audit events">No events match these filters.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="data-table responsive-table audit-table">
              <thead>
                <tr>
                  <th scope="col">Timestamp</th>
                  <th scope="col">Event</th>
                  <th scope="col">Subaward</th>
                  <th scope="col">Actor</th>
                  <th scope="col">Details</th>
                </tr>
              </thead>
              <tbody>
                {q.data.items.map((e) => (
                  <Fragment key={e.id}>
                    <tr>
                      <td data-label="Timestamp" className="nowrap">
                        {formatDateTime(e.timestamp)}
                      </td>
                      <td data-label="Event">
                        <span className={`event-pill ev-${e.eventType}`}>{EVENT_LABELS[e.eventType] ?? e.eventType}</span>
                      </td>
                      <td data-label="Subaward">
                        {e.subawardId ? <Link to={`/subawards/${e.subawardId}`}>{e.subrecipientName ?? 'Unnamed record'}</Link> : '—'}
                      </td>
                      <td data-label="Actor">
                        <div>
                          <div>{e.actorName}</div>
                          {e.actor !== 'system' && <div className="cell-secondary">{e.actor}</div>}
                        </div>
                      </td>
                      <td data-label="Details">
                        <div>
                        <div>{describeEvent(e.eventType, e.details)}</div>
                        <button className="btn btn-link btn-xs" onClick={() => setExpanded(expanded === e.id ? null : e.id)} aria-expanded={expanded === e.id}>
                          {expanded === e.id ? 'Hide raw details' : 'Show raw details'}
                        </button>
                        </div>
                      </td>
                    </tr>
                    {expanded === e.id && (
                      <tr className="raw-row">
                        <td colSpan={5}>
                          <pre className="raw-json">{JSON.stringify({ id: e.id, subaward_id: e.subawardId, event_type: e.eventType, actor: e.actor, timestamp: e.timestamp, details: e.details }, null, 2)}</pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {pages > 1 && (
          <div className="pager">
            <button className="btn btn-secondary btn-sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              Previous
            </button>
            <span className="muted small">
              Page {page + 1} of {pages}
            </span>
            <button className="btn btn-secondary btn-sm" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
              Next
            </button>
          </div>
        )}
      </section>
    </>
  );
}
