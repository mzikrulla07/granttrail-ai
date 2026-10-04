import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { Layout } from './components/Layout';
import { NotFoundPage, RouteError } from './components/RouteError';
import { AuditPage } from './pages/AuditPage';
import { DashboardPage } from './pages/DashboardPage';
import { ReviewPage } from './pages/ReviewPage';
import { SubawardsPage } from './pages/SubawardsPage';
import { UploadPage } from './pages/UploadPage';
import { SessionProvider } from './session';
import './styles.css';

const router = createBrowserRouter([
  {
    element: <Layout />,
    errorElement: <RouteError />,
    children: [
      {
        // Pathless boundary: a crash inside any page keeps the app shell and navigation.
        errorElement: <RouteError />,
        children: [
          { path: '/', element: <DashboardPage /> },
          { path: '/upload', element: <UploadPage /> },
          { path: '/subawards', element: <SubawardsPage /> },
          { path: '/subawards/:id', element: <ReviewPage /> },
          { path: '/audit', element: <AuditPage /> },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SessionProvider>
      <RouterProvider router={router} />
    </SessionProvider>
  </StrictMode>,
);
