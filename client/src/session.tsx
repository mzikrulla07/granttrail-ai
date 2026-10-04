import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, getDemoUser, setDemoUser } from './api/client';
import type { DemoUser, Health, Me, Permission } from './api/types';

interface SessionState {
  health: Health | null;
  me: Me | null;
  demoUsers: DemoUser[];
  loading: boolean;
  /** True while waiting for the API to finish starting */
  waiting: boolean;
  error: string | null;
  can: (p: Permission) => boolean;
  switchUser: (email: string) => void;
  reload: () => void;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [demoUsers, setDemoUsers] = useState<DemoUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [waiting, setWaiting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        // On first start the API may still be migrating/seeding: wait for it (up to ~30 s).
        let h: Health | null = null;
        for (let attempt = 0; !h; attempt++) {
          try {
            h = await api.health();
          } catch (e) {
            const starting = e instanceof ApiError && (e.code === 'NETWORK' || e.code === 'SERVER_UNAVAILABLE');
            if (!starting || attempt >= 30 || cancelled) throw e;
            setWaiting(true);
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
        setWaiting(false);
        const users = h.modes.auth === 'dev' ? await api.demoUsers() : [];
        const current = await api.me();
        if (cancelled) return;
        setHealth(h);
        setDemoUsers(users);
        setMe(current);
        if (h.modes.auth === 'dev' && !getDemoUser()) setDemoUser(current.email);
      } catch (e) {
        if (!cancelled) setError(e instanceof ApiError ? e.message : 'Unable to start GrantTrail.');
      } finally {
        if (!cancelled) {
          setLoading(false);
          setWaiting(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [version]);

  const can = useCallback((p: Permission) => !!me?.permissions.includes(p), [me]);
  const switchUser = useCallback((email: string) => {
    setDemoUser(email);
    setVersion((v) => v + 1);
  }, []);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  return (
    <SessionContext.Provider value={{ health, me, demoUsers, loading, waiting, error, can, switchUser, reload }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside SessionProvider');
  return ctx;
}
