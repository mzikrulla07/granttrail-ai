import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import type { ListFilter } from '../api/types';
import { FILTERS, FilterTabs, SubawardTable } from '../components/SubawardTable';
import { ErrorState, Icon, PageHeader, Spinner } from '../components/ui';
import { useAsync } from '../lib/useAsync';
import { useSession } from '../session';

export function SubawardsPage() {
  const { can, me } = useSession();
  const [params, setParams] = useSearchParams();
  const raw = params.get('filter') as ListFilter | null;
  const filter: ListFilter = raw && FILTERS.some((f) => f.key === raw) ? raw : 'all';
  const [search, setSearch] = useState(params.get('q') ?? '');
  const [debounced, setDebounced] = useState(search);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  const list = useAsync(() => api.list(filter, debounced), [filter, debounced, me?.email]);

  const setFilter = (f: ListFilter) => {
    const next = new URLSearchParams(params);
    if (f === 'all') next.delete('filter');
    else next.set('filter', f);
    setParams(next, { replace: true });
  };

  return (
    <>
      <PageHeader
        title="Subawards"
        subtitle="Every subaward agreement received from partner agencies, with reporting status and validation results."
        actions={
          can('subaward:upload') && (
            <Link className="btn btn-primary" to="/upload">
              <Icon name="upload" size={16} />
              Upload Agreement
            </Link>
          )
        }
      />
      <section className="panel">
        <div className="panel-header panel-header-wrap">
          <FilterTabs value={filter} onChange={setFilter} />
          <label className="search-box">
            <Icon name="search" size={16} />
            <span className="sr-only">Search by subrecipient or UEI</span>
            <input
              type="search"
              placeholder="Search subrecipient or UEI"
              value={search}
              maxLength={100}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
        </div>
        {list.error ? (
          <ErrorState message={list.error} onRetry={list.reload} />
        ) : list.loading && !list.data ? (
          <Spinner label="Loading subawards…" />
        ) : (
          <>
            <p className="result-count" aria-live="polite">
              {list.data?.length ?? 0} record{list.data?.length === 1 ? '' : 's'}
            </p>
            <SubawardTable items={list.data ?? []} filter={filter} canEdit={can('subaward:edit')} />
          </>
        )}
      </section>
    </>
  );
}
