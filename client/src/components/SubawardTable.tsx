import { Link } from 'react-router-dom';
import type { ListFilter, SubawardSummary } from '../api/types';
import { formatCurrency, formatDate } from '../lib/format';
import { EmptyState, SeverityBadge, StatusBadge, TimelinessBadge } from './ui';

export const FILTERS: { key: ListFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'due_soon', label: 'Due Soon' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'awaiting_review', label: 'Awaiting Review' },
  { key: 'approved', label: 'Approved' },
  { key: 'reported', label: 'Reported' },
];

export function FilterTabs({ value, onChange, counts }: { value: ListFilter; onChange: (f: ListFilter) => void; counts?: Partial<Record<ListFilter, number>> }) {
  return (
    <div className="filter-tabs" role="tablist" aria-label="Filter subawards">
      {FILTERS.map((f) => (
        <button
          key={f.key}
          role="tab"
          aria-selected={value === f.key}
          className={value === f.key ? 'active' : ''}
          onClick={() => onChange(f.key)}
        >
          {f.label}
          {counts?.[f.key] !== undefined && <span className="tab-count">{counts[f.key]}</span>}
        </button>
      ))}
    </div>
  );
}

export function SubawardTable({ items, filter, canEdit }: { items: SubawardSummary[]; filter: ListFilter; canEdit: boolean }) {
  if (items.length === 0) {
    const label = FILTERS.find((f) => f.key === filter)?.label ?? '';
    return (
      <EmptyState title={filter === 'all' ? 'No subawards yet' : `No ${label.toLowerCase()} subawards`}>
        {filter === 'all'
          ? 'Upload a signed subaward agreement to create the first record.'
          : 'Nothing matches this filter right now.'}
      </EmptyState>
    );
  }
  return (
    <div className="table-wrap">
      <table className="data-table responsive-table">
        <thead>
          <tr>
            <th scope="col">Subrecipient</th>
            <th scope="col" className="num">
              Amount
            </th>
            <th scope="col">Award Date</th>
            <th scope="col">Due Date</th>
            <th scope="col">Status</th>
            <th scope="col">Validation</th>
            <th scope="col">Action</th>
          </tr>
        </thead>
        <tbody>
          {items.map((s) => (
            <tr key={s.id} className={s.timeliness === 'overdue' && s.status !== 'reported' ? 'row-overdue' : undefined}>
              <td data-label="Subrecipient">
                <div>
                  <div className="cell-primary">{s.subrecipientName ?? <em className="muted">Name not extracted</em>}</div>
                  <div className="cell-secondary mono">{s.uei ? `UEI ${s.uei}` : 'UEI missing'}</div>
                </div>
              </td>
              <td data-label="Amount" className="num">
                {formatCurrency(s.amount)}
              </td>
              <td data-label="Award Date">{formatDate(s.awardDate)}</td>
              <td data-label="Due Date">
                <div>
                  <div>{formatDate(s.dueDate)}</div>
                  {s.status !== 'reported' && <TimelinessBadge timeliness={s.timeliness} days={s.daysUntilDue} />}
                </div>
              </td>
              <td data-label="Status">
                <StatusBadge status={s.status} />
              </td>
              <td data-label="Validation">
                <SeverityBadge
                  severity={s.validationStatus}
                  label={
                    s.validationStatus === 'ERROR'
                      ? `${s.errorCount} error${s.errorCount === 1 ? '' : 's'}`
                      : s.validationStatus === 'WARNING'
                        ? `${s.warningCount} warning${s.warningCount === 1 ? '' : 's'}`
                        : 'Pass'
                  }
                />
              </td>
              <td data-label="Action" className="cell-action">
                <Link className={`btn btn-sm ${s.status === 'awaiting_review' && canEdit ? 'btn-primary' : 'btn-secondary'}`} to={`/subawards/${s.id}`}>
                  {s.status === 'awaiting_review' && canEdit ? 'Review' : 'View'}
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
