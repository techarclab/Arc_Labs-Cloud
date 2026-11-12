import { FormEvent, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, isAdmin, Org } from '../api';
import { ArcMark, ErrorBox } from '../components/ui';
import { slugify } from '../format';
import { useSession } from '../session';
import { JoinInviteDialog } from './Onboarding';

/** A random suffix keeps personal workspace short names unique without asking for one. */
const suffix = () => Math.random().toString(36).slice(2, 6);

/**
 * Create the first workspace (if needed) and a channel. Most people get a personal workspace, named for them,
 * so they only name the channel; only ARC LABS staff set up a named organization here.
 */
export function SetupPage() {
  const { user, orgs, refreshOrgs, refreshProjects, signOut } = useSession();
  const staff = !!user?.isPlatformAdmin;
  const [params] = useSearchParams();
  const nav = useNavigate();
  const adminOrgs = orgs.filter((o) => isAdmin(o.role));
  const presetOrg = params.get('org');
  const [orgChoice, setOrgChoice] = useState<string>(presetOrg ?? adminOrgs[0]?.id ?? 'new');
  const [orgName, setOrgName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [joining, setJoining] = useState(false);

  const creatingOrg = orgChoice === 'new';

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      let orgId = orgChoice;
      if (creatingOrg) {
        const first = (user?.displayName || user?.email.split('@')[0] || 'My').trim();
        const body = staff
          ? { name: orgName, slug: slug || slugify(orgName) }
          : { name: `${first}’s workspace`.slice(0, 120), slug: `${slugify(first).slice(0, 40) || 'me'}-${suffix()}` };
        const org = await api<Org>('POST', '/organizations', body);
        orgId = org.id;
        await refreshOrgs();
      }
      const p = await api('POST', '/projects', { organizationId: orgId, name: projectName });
      await refreshProjects(orgId);
      nav(`/o/${orgId}/p/${p.id}/settings`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <div className="auth-form" style={{ minHeight: '100%' }}>
      <form className="auth-card form" onSubmit={submit} style={{ width: 'min(440px, 100%)' }}>
        <div className="brand" style={{ color: 'var(--ink)' }}>
          <ArcMark size={30} />
          ARC Cloud
        </div>
        <div>
          <h2 style={{ fontSize: 24 }}>{creatingOrg && !orgs.length ? 'Create your first channel' : 'New channel'}</h2>
          <p className="muted" style={{ marginTop: 6 }}>
            {creatingOrg && !staff
              ? 'We’ll put it in your personal workspace on the free plan: up to 5 devices and 3 channels. '
              : creatingOrg
                ? 'An organization is a company, lab or college that ARC LABS sets up. '
                : ''}
            A channel groups devices that send the same fields, such as all the sensors in one greenhouse. Each channel has its own fields and dashboard.
          </p>
        </div>

        {adminOrgs.length > 0 && (
          <label className="field">
            Organization
            <select value={orgChoice} onChange={(e) => setOrgChoice(e.target.value)}>
              {adminOrgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
              <option value="new">{staff ? 'Create a new organization…' : 'New personal workspace…'}</option>
            </select>
          </label>
        )}

        {creatingOrg && staff && (
          <>
            <label className="field">
              Organization name
              <input
                required
                value={orgName}
                placeholder="ARC LABS"
                onChange={(e) => {
                  setOrgName(e.target.value);
                  if (!slugTouched) setSlug(slugify(e.target.value));
                }}
                autoFocus
              />
            </label>
            <label className="field">
              Short name
              <span className="hint">Lowercase letters, numbers and dashes. Used in links.</span>
              <input
                required
                pattern="[a-z0-9][a-z0-9\-]{1,62}"
                value={slug}
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(e.target.value);
                }}
              />
            </label>
          </>
        )}

        <label className="field">
          Channel name
          <input required value={projectName} placeholder="Greenhouse monitoring" onChange={(e) => setProjectName(e.target.value)} autoFocus={!creatingOrg || !staff} />
        </label>

        <ErrorBox error={error} />
        <button className="btn primary" disabled={busy} type="submit">
          {busy ? 'Creating…' : 'Create channel'}
        </button>
        {creatingOrg && !orgs.length && (
          <p className="small muted">
            Got an invite code from your college or company?{' '}
            <button type="button" className="link-btn" onClick={() => setJoining(true)}>
              Join their organization instead
            </button>
          </p>
        )}
        <div className="row small">
          {orgs.length > 0 && (
            <button type="button" className="btn quiet small" onClick={() => nav(-1)}>
              Cancel
            </button>
          )}
          <button type="button" className="btn quiet small" onClick={signOut}>
            Sign out
          </button>
        </div>
      </form>
      <JoinInviteDialog open={joining} onClose={() => setJoining(false)} />
    </div>
  );
}
