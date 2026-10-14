import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import { api, isAdmin, ROLE_LABEL } from '../api';
import { useSession } from '../session';
import { ArcMark, usePoll } from './ui';
import { Icon } from './icons';

function initials(name?: string) {
  const words = (name ?? '').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  return (words.length ? words.map((w) => w[0]).slice(0, 2).join('') : '?').toUpperCase();
}

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
          <ArcMark size={28} />
          <span>ARC Cloud</span>
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
          <div className="org-name">
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
              <span className="nav-label"><Icon name="channel" />{p.name}</span>
              <span className="count">{p.deviceCount ?? ''}</span>
            </NavLink>
          ))}
        </nav>

        <nav className="side-group" aria-label="Organization">
          <div className="side-heading">Organization</div>
          <NavLink to={`/o/${orgId}`} end className={link}>
            <span className="nav-label"><Icon name="overview" />Overview</span>
          </NavLink>
          <NavLink to={`/o/${orgId}/alerts`} className={link}>
            <span className="nav-label"><Icon name="alerts" />Alerts</span>
            {openAlerts > 0 && <span className="count alert-count">{openAlerts}</span>}
          </NavLink>
          <NavLink to={`/o/${orgId}/team`} className={link}>
            <span className="nav-label"><Icon name="team" />Team</span>
          </NavLink>
          {isAdmin(org?.role) && (
            <NavLink to={`/o/${orgId}/integrations`} className={link}>
              <span className="nav-label"><Icon name="integrations" />Integrations</span>
            </NavLink>
          )}
          <NavLink to={`/o/${orgId}/firmware`} className={link}>
            <span className="nav-label"><Icon name="firmware" />Firmware &amp; OTA</span>
          </NavLink>
          <NavLink to={`/o/${orgId}/usage`} className={link}>
            <span className="nav-label"><Icon name="usage" />Usage &amp; limits</span>
          </NavLink>
          <NavLink to={`/o/${orgId}/rejected`} className={link}>
            <span className="nav-label"><Icon name="rejected" />Rejected data</span>
          </NavLink>
          {isAdmin(org?.role) && (
            <NavLink to={`/o/${orgId}/audit`} className={link}>
              <span className="nav-label"><Icon name="audit" />Audit log</span>
            </NavLink>
          )}
        </nav>

        {user?.isPlatformAdmin && (
          <nav className="side-group" aria-label="ARC LABS">
            <div className="side-heading">ARC LABS</div>
            <NavLink to={`/o/${orgId}/platform`} className={link}>
              <span className="nav-label"><Icon name="admin" />All organizations</span>
            </NavLink>
          </nav>
        )}

        <div className="side-foot">
          <div className="me">
            <span className="avatar" aria-hidden="true">
              {initials(user?.displayName)}
            </span>
            <span>
              <b>{user?.displayName}</b>
              <span>{org?.role ? ROLE_LABEL[org.role] : ''}</span>
            </span>
          </div>
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
