import { useEffect, useState } from 'react';
import { Navigate, NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, isAdmin, isScoped, ROLE_LABEL } from '../api';
import { useSession } from '../session';
import { ArcMark, usePoll, useToast } from './ui';
import { Icon } from './icons';
import { JoinInviteDialog } from '../pages/Onboarding';

function initials(name?: string) {
  const words = (name ?? '').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  return (words.length ? words.map((w) => w[0]).slice(0, 2).join('') : '?').toUpperCase();
}

export function Layout() {
  const { orgId = '', projectId } = useParams();
  const { orgs, projects, refreshProjects, refreshOrgs, user, signOut } = useSession();
  const toast = useToast();
  const nav = useNavigate();
  const org = orgs.find((o) => o.id === orgId);
  const list = projects[orgId];
  const link = ({ isActive }: { isActive: boolean }) => `side-link${isActive ? ' active' : ''}`;
  const [openAlerts, setOpenAlerts] = useState(0);
  const [joining, setJoining] = useState(false);
  const location = useLocation();
  // Teachers, trainers, students and employees see only their channels: no organization-wide pages or overview.
  const scoped = isScoped(org?.role);
  usePoll(
    () =>
      orgId && !scoped
        ? api<{ alerts: { triggered: number } }>('GET', `/organizations/${orgId}/overview`)
            .then((o) => setOpenAlerts(o.alerts.triggered))
            .catch(async (err) => {
              // Removed from this organization (or it was deleted): leave it instead of showing stale data.
              if (err instanceof ApiError && err.status === 404) {
                const name = org?.name ?? 'this organization';
                const left = await refreshOrgs().catch(() => []);
                toast(`You no longer have access to ${name}.`);
                nav(left[0] ? `/o/${left[0].id}` : '/', { replace: true });
              }
            })
        : undefined,
    15_000,
    [orgId, scoped],
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

  // The organization's overview is not for scoped roles: open their first channel instead.
  const atOrgHome = location.pathname.replace(/\/+$/, '') === `/o/${orgId}`;
  if (scoped && atOrgHome && list?.length) return <Navigate to={`/o/${orgId}/p/${list[0].id}`} replace />;

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
              const id = e.target.value;
              // An organization without channels opens its overview (it used to open "create organization").
              const ps = await refreshProjects(id).catch(() => []);
              nav(ps[0] ? `/o/${id}/p/${ps[0].id}` : `/o/${id}`);
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

        {scoped && !list?.length && (
          <p className="side-empty small">No channels yet. Your teacher or an admin gives you access to channels.</p>
        )}

        {!scoped && (
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
        )}

        {user?.isPlatformAdmin && (
          <nav className="side-group" aria-label="ARC LABS">
            <div className="side-heading">ARC LABS</div>
            <NavLink to={`/o/${orgId}/platform`} className={link}>
              <span className="nav-label"><Icon name="admin" />All organizations</span>
            </NavLink>
          </nav>
        )}

        <div className="side-foot">
          <div
            className="me"
            role="link"
            tabIndex={0}
            title="Your account"
            onClick={() => nav(`/o/${orgId}/account`)}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && nav(`/o/${orgId}/account`)}
          >
            <span className="avatar" aria-hidden="true">
              {initials(user?.displayName)}
            </span>
            <span>
              <b>{user?.displayName}</b>
              {/* A role is per organization: being Admin of your own organization gives no access to anyone else's. */}
              <span title={org ? `Your role in ${org.name}` : undefined}>
                {user?.isPlatformAdmin ? 'ARC LABS admin · ' : ''}
                {/* Your own free workspace is not an organization you administer for others. */}
                {org?.role === 'individual' ? 'Personal workspace' : org?.role ? `${ROLE_LABEL[org.role]} of ${org.name}` : ''}
              </span>
            </span>
          </div>
          <button type="button" onClick={() => setJoining(true)}>
            Join with invite code
          </button>
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
        {scoped && atOrgHome ? (
          <div className="empty">
            <h3>No channels yet</h3>
            <p>
              You are {org?.role === 'student' ? 'a student' : `a${org?.role === 'employee' ? 'n' : ''} ${ROLE_LABEL[org!.role!].toLowerCase()}`} in {org?.name}. You see the channels your teacher or an admin gives you
              access to; none so far.
            </p>
          </div>
        ) : (
          <Outlet context={{ org }} />
        )}
      </main>
      <JoinInviteDialog open={joining} onClose={() => setJoining(false)} />
    </div>
  );
}
