import { isRouteErrorResponse, Link, useRouteError } from 'react-router-dom';
import { Icon, PageHeader } from './ui';

/**
 * Error boundary for every page. If a page throws while rendering, the app
 * shell (header + navigation) stays usable and the user sees a friendly
 * message instead of a blank white screen. Technical details go to the
 * browser console only — never to the screen.
 */
export function RouteError() {
  const error = useRouteError();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  if (!notFound) console.error('[GrantTrail] page crashed:', error);
  return (
    <>
      <PageHeader title={notFound ? 'Page not found' : 'Something went wrong'} />
      <div className="state-block error-state" role="alert">
        <Icon name="error" size={28} />
        <p>
          {notFound
            ? 'The page you were looking for does not exist.'
            : 'This page hit an unexpected problem. Your saved data is safe — nothing is changed until you save or approve.'}
        </p>
        <div className="page-actions">
          {!notFound && (
            <button className="btn btn-secondary" onClick={() => window.location.reload()}>
              Reload page
            </button>
          )}
          <Link className="btn btn-primary" to="/">
            Go to dashboard
          </Link>
        </div>
      </div>
    </>
  );
}

export function NotFoundPage() {
  return (
    <>
      <PageHeader title="Page not found" />
      <div className="state-block empty-state">
        <Icon name="file" size={28} />
        <p>The page you were looking for does not exist.</p>
        <Link className="btn btn-primary" to="/">
          Go to dashboard
        </Link>
      </div>
    </>
  );
}
