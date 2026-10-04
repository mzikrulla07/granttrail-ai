/**
 * Browser API client.
 *  - Talks only to our own backend (/api). No third-party or AI API is ever
 *    called from the browser, and no API keys exist in client code.
 *  - Errors are normalised into ApiError with a user-safe message. The server
 *    already sanitises messages; anything unexpected becomes a generic message.
 *
 * Production (Cognito): replace `authHeaders()` with
 *   { Authorization: `Bearer ${accessToken}` } from the Cognito session.
 */
import type {
  AuditEvent,
  DashboardData,
  DemoUser,
  FieldName,
  Health,
  ListFilter,
  Me,
  SubawardDetail,
  SubawardSummary,
  ValidationReport,
} from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const DEMO_USER_KEY = 'granttrail.demoUser';

export function getDemoUser(): string | null {
  try {
    return window.localStorage.getItem(DEMO_USER_KEY);
  } catch {
    return null;
  }
}

export function setDemoUser(email: string) {
  try {
    window.localStorage.setItem(DEMO_USER_KEY, email);
  } catch {
    /* storage unavailable — falls back to server default user */
  }
}

function authHeaders(): Record<string, string> {
  const u = getDemoUser();
  // X-Requested-With is always sent: the server requires a custom header on
  // state-changing requests (CSRF protection — cross-site pages cannot add one).
  return u ? { 'X-Demo-User': u, 'X-Requested-With': 'GrantTrail' } : { 'X-Requested-With': 'GrantTrail' };
}

const GENERIC = 'Something went wrong. Please try again.';

async function toApiError(res: Response): Promise<ApiError> {
  let body: { error?: { code?: string; message?: string; details?: unknown; requestId?: string } } = {};
  try {
    body = await res.json();
  } catch {
    /* non-JSON (e.g. proxy error page) — never shown to users */
  }
  const e = body.error;
  if (!e && res.status >= 500) {
    // No JSON error envelope: the dev proxy or load balancer could not reach the API.
    return new ApiError(res.status, 'SERVER_UNAVAILABLE', 'The GrantTrail server is not responding. Make sure it is running and try again.');
  }
  if (!e?.message || res.status >= 500) {
    return new ApiError(res.status, e?.code ?? 'UNEXPECTED', GENERIC, undefined, e?.requestId);
  }
  return new ApiError(res.status, e.code ?? 'ERROR', e.message, e.details, e.requestId);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        ...authHeaders(),
        ...(init.headers ?? {}),
      },
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the GrantTrail server. Check your connection and that the server is running.');
  }
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as T;
}

async function download(path: string): Promise<{ blob: Blob; filename: string }> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { headers: authHeaders() });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the GrantTrail server.');
  }
  if (!res.ok) throw await toApiError(res);
  const cd = res.headers.get('Content-Disposition') ?? '';
  const filename = /filename="([^"]+)"/.exec(cd)?.[1] ?? 'granttrail-export.csv';
  return { blob: await res.blob(), filename };
}

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type FieldPatch = Partial<Record<FieldName, string | null>>;

export const api = {
  health: () => request<Health>('/health'),
  demoUsers: () => request<{ users: DemoUser[] }>('/auth/demo-users').then((r) => r.users),
  me: () => request<{ user: Me }>('/me').then((r) => r.user),
  dashboard: () => request<DashboardData>('/dashboard'),
  list: (filter: ListFilter, search?: string) => {
    const q = new URLSearchParams({ filter });
    if (search?.trim()) q.set('search', search.trim());
    return request<{ items: SubawardSummary[] }>(`/subawards?${q}`).then((r) => r.items);
  },
  get: (id: string) => request<{ subaward: SubawardDetail }>(`/subawards/${encodeURIComponent(id)}`).then((r) => r.subaward),
  upload: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return request<{ subaward: SubawardDetail }>('/subawards/upload', { method: 'POST', body: fd }).then((r) => r.subaward);
  },
  previewValidation: (id: string, fields: FieldPatch) =>
    request<{ validation: ValidationReport }>(`/subawards/${id}/validate-preview`, {
      method: 'POST',
      body: JSON.stringify({ fields }),
    }).then((r) => r.validation),
  saveDraft: (id: string, fields: FieldPatch) =>
    request<{ subaward: SubawardDetail }>(`/subawards/${id}`, { method: 'PATCH', body: JSON.stringify({ fields }) }).then(
      (r) => r.subaward,
    ),
  approve: (id: string, fields: FieldPatch) =>
    request<{ subaward: SubawardDetail }>(`/subawards/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ attestation: true, fields }),
    }).then((r) => r.subaward),
  markReported: (id: string, reference?: string) =>
    request<{ subaward: SubawardDetail }>(`/subawards/${id}/mark-reported`, {
      method: 'POST',
      body: JSON.stringify(reference ? { reference } : {}),
    }).then((r) => r.subaward),
  exportOne: (id: string) => download(`/subawards/${id}/export.csv`),
  exportApproved: () => download('/exports/approved.csv'),
  documentBlob: (id: string) => download(`/subawards/${id}/document`).then((r) => r.blob),
  audit: (params: { subawardId?: string; eventType?: string; limit?: number; offset?: number }) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => v !== undefined && v !== '' && q.set(k, String(v)));
    return request<{ total: number; items: AuditEvent[] }>(`/audit-events?${q}`);
  },
};
