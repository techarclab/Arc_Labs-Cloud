import { FormEvent, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, isAdmin, Org } from '../api';
import { ArcMark, ErrorBox } from '../components/ui';
import { slugify } from '../format';
import { useSession } from '../session';

/** Create the first organization (if needed) and a project. */
export function SetupPage() {
  const { orgs, refreshOrgs, refreshProjects, signOut } = useSession();
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

  const creatingOrg = orgChoice === 'new';

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      let orgId = orgChoice;
      if (creatingOrg) {
        const org = await api<Org>('POST', '/organizations', { name: orgName, slug: slug || slugify(orgName) });
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
          <h2 style={{ fontSize: 24 }}>{creatingOrg && !orgs.length ? 'Set up your workspace' : 'New channel'}</h2>
          <p className="muted" style={{ marginTop: 6 }}>
            An organization is your company, lab or college. A channel groups devices that send the same fields, such as all the sensors in one greenhouse. Each channel has its own fields and dashboard.
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
              <option value="new">Create a new organization…</option>
            </select>
          </label>
        )}

        {creatingOrg && (
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
          <input required value={projectName} placeholder="Greenhouse monitoring" onChange={(e) => setProjectName(e.target.value)} autoFocus={!creatingOrg} />
        </label>

        <ErrorBox error={error} />
        <button className="btn primary" disabled={busy} type="submit">
          {busy ? 'Creating…' : 'Create channel'}
        </button>
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
    </div>
  );
}
