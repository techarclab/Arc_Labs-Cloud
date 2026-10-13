import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import { api, isAdmin, ROLE_LABEL } from '../api';
import { useSession } from '../session';
import { ArcMark, usePoll } from './ui';

export function Layout() {
  const { orgId = '', projectId } = useParams();
  const { orgs, projects, refreshProjects, user, signOut } = useSession();
  const nav = useNavigate();
  const org = orgs.find((o) => o.id === orgId);
  const list = projects[orgId];
  const link = ({ isActive }: { isActive: boolean }) => `side-link${isActive ? ' active' : ''}`;
  const [openAlerts, setOpenAlerts] = useState(0);
  usePoll(
    () =>
      orgId
        ? api<{ alerts: { triggered: number } }>('GET', `/organizations/${orgId}/overview`)
            .then((o) => setOpenAlerts(o.alerts.triggered))
            .catch(() => undefined)
        : undefined,
    30_000,
    [orgId],
  );

  useEffect(() => {
    if (orgId && !list) void refreshProjects(orgId).catch(() => undefined);
  }, [orgId, list, refreshProjects]);

  useEffect(() => {
    if (projectId) {
      try {
        localStorage.setItem('arc.lastProject', projectId);
      } catch {
        /* ignore */
      }
    }
  }, [projectId]);

  if (orgs.length && !org) {
    return (
      <div className="main">
        <div className="empty">
          <h3>This organization isn’t available</h3>
          <p>It may not exist, or you’re not a member.</p>
          <button className="btn" onClick={() => nav('/')}>
            Go to my channels
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <ArcMark />
          ARC Cloud
        </div>

        {orgs.length > 1 ? (
          <select
            className="org-select"
            aria-label="Organization"
            value={orgId}
            onChange={async (e) => {
              const ps = await refreshProjects(e.target.value);
              nav(ps[0] ? `/o/${e.target.value}/p/${ps[0].id}` : '/setup');
            }}
          >
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        ) : (
          <div className="side-heading" style={{ color: '#fff', fontSize: 15, padding: '0 8px' }}>
            {org?.name}
          </div>
        )}

        <nav className="side-group" aria-label="Channels">
          <div className="side-heading">
            Channels
            {isAdmin(org?.role) && (
              <button title="New channel" aria-label="New channel" onClick={() => nav(`/setup?org=${orgId}`)}>
                +
              </button>
            )}
          </div>
          {list?.map((p) => (
            <NavLink key={p.id} to={`/o/${orgId}/p/${p.id}`} end={false} className={({ isActive }) => `side-link${isActive ? ' active' : ''}`}>
              <span>{p.name}</span>
              <span className="count">{p.deviceCount ?? ''}</span>
            </NavLink>
          ))}
        </nav>

        <nav className="side-group" aria-label="Organization">
          <div className="side-heading">Organization</div>
          <NavLink to={`/o/${orgId}`} end className={link}>
            Overview
          </NavLink>
          <NavLink to={`/o/${orgId}/alerts`} className={link}>
            <span>Alerts</span>
            {openAlerts > 0 && <span className="count alert-count">{openAlerts}</span>}
          </NavLink>
          <NavLink to={`/o/${orgId}/team`} className={link}>
            Team
          </NavLink>
          {isAdmin(org?.role) && (
            <NavLink to={`/o/${orgId}/integrations`} className={link}>
              Integrations
            </NavLink>
          )}
          <NavLink to={`/o/${orgId}/firmware`} className={link}>
            Firmware &amp; OTA
          </NavLink>
          <NavLink to={`/o/${orgId}/usage`} className={link}>
            Usage &amp; limits
          </NavLink>
          <NavLink to={`/o/${orgId}/rejected`} className={({ isActive }) => `side-link${isActive ? ' active' : ''}`}>
            Rejected data
          </NavLink>
          {isAdmin(org?.role) && (
            <NavLink to={`/o/${orgId}/audit`} className={({ isActive }) => `side-link${isActive ? ' active' : ''}`}>
              Audit log
            </NavLink>
          )}
        </nav>

        {user?.isPlatformAdmin && (
          <nav className="side-group" aria-label="ARC LABS">
            <div className="side-heading">ARC LABS</div>
            <NavLink to={`/o/${orgId}/platform`} className={link}>
              All organizations
            </NavLink>
          </nav>
        )}

        <div className="side-foot">
          <span>{user?.displayName}</span>
          <span>{org?.role ? ROLE_LABEL[org.role] : ''}</span>
          <button
            onClick={() => {
              signOut();
              nav('/');
            }}
          >
            Sign out
          </button>
        </div>
      </aside>
      <main className="main">
        <Outlet context={{ org }} />
      </main>
    </div>
  );
}
