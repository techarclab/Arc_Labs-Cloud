import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { api, getToken, onUnauthorized, Org, Project, setToken } from './api';

interface User {
  id: string;
  email: string;
  displayName: string;
  isPlatformAdmin?: boolean;
  /** Privacy notice version this person accepted (null: never), and the version in force. */
  termsVersion?: string | null;
  currentTermsVersion?: string;
}
interface SessionValue {
  user: User | null;
  orgs: Org[];
  loading: boolean;
  signIn: (token: string) => Promise<void>;
  signOut: () => void;
  reload: () => Promise<void>;
  refreshOrgs: () => Promise<Org[]>;
  projects: Record<string, Project[]>;
  refreshProjects: (orgId: string) => Promise<Project[]>;
}

const Ctx = createContext<SessionValue>(null as unknown as SessionValue);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [projects, setProjects] = useState<Record<string, Project[]>>({});
  const [loading, setLoading] = useState(true);

  const refreshOrgs = useCallback(async () => {
    const r = await api<{ items: Org[] }>('GET', '/organizations');
    setOrgs(r.items);
    return r.items;
  }, []);

  const refreshProjects = useCallback(async (orgId: string) => {
    const r = await api<{ items: Project[] }>('GET', `/projects?organizationId=${orgId}`);
    setProjects((p) => ({ ...p, [orgId]: r.items }));
    return r.items;
  }, []);

  const load = useCallback(async () => {
    if (!getToken()) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      const me = await api('GET', '/auth/me');
      setUser({ ...me.user, isPlatformAdmin: !!me.isPlatformAdmin, currentTermsVersion: me.currentTermsVersion });
      await refreshOrgs();
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, [refreshOrgs]);

  useEffect(() => {
    void load();
    return onUnauthorized(() => {
      setUser(null);
      setOrgs([]);
      setProjects({});
    });
  }, [load]);

  const signIn = useCallback(
    async (token: string) => {
      setToken(token);
      setLoading(true);
      await load();
    },
    [load],
  );

  const signOut = useCallback(() => {
    setToken(null);
    setUser(null);
    setOrgs([]);
    setProjects({});
  }, []);

  return <Ctx.Provider value={{ user, orgs, loading, signIn, signOut, reload: load, refreshOrgs, projects, refreshProjects }}>{children}</Ctx.Provider>;
}

export const useSession = () => useContext(Ctx);
