/**
 * ARC Cloud privacy notice: public at /privacy, accepted at sign-up, and accepted again by every signed-in person
 * whenever PRIVACY_VERSION changes (TermsGate). PRIVACY_VERSION must equal TERMS_VERSION in apps/api/src/common/invites.ts.
 * Every statement describes how this deployment actually works; when the system changes, change this text and bump both.
 */
import { useState } from 'react';
import { api } from '../api';
import { ArcMark, ErrorBox } from '../components/ui';

export const PRIVACY_VERSION = '2026-10-30';

export function PrivacyNotice() {
  return (
    <>
      <p>
        ARC Cloud is run by ARC LABS, Hyderabad, India. This notice explains what personal data ARC Cloud keeps, why, where, for how long, who can see it,
        and what you can ask us to do, under India’s Digital Personal Data Protection Act, 2023 (DPDP Act) and the DPDP Rules, 2025.
      </p>

      <h2>What we keep</h2>
      <ul>
        <li>
          <b>Your account:</b> name, email address, your password (stored only as a salted scrypt hash, never readable), the organizations you belong to
          and your role in each, the invite code you used, and which version of this notice you accepted and when.
        </li>
        <li>
          <b>What your devices send and receive:</b> readings, device state, firmware versions, commands and alerts, in the organization they belong to.
        </li>
        <li>
          <b>Your settings:</b> dashboards, alert rules and the email addresses alerts go to, API keys and webhooks.
        </li>
        <li>
          <b>Security records:</b> an audit log of actions such as sign-ups, sign-ins, changes and deletions, and server logs that include IP addresses.
        </li>
        <li>
          <b>In your browser:</b> your sign-in token, the project and dashboard you last opened, and for lab sessions a token that is removed when you close
          the tab, all in your browser’s own storage. No advertising or tracking cookies.
        </li>
      </ul>
      <p>A device keeps its Wi-Fi name and password in its own memory; they are not sent to ARC Cloud.</p>

      <h2>Why we use it</h2>
      <p>
        Only to run ARC Cloud for your organization: to show your data, run alerts, commands and firmware updates, keep accounts and devices secure, and
        give support you ask for. We rely on the consent you give by accepting this notice, and on the uses the DPDP Act allows without consent, such as
        complying with the law. We do not sell personal data, let advertisers use it, or use it for marketing.
      </p>

      <h2>Your organization’s role</h2>
      <p>
        Your organization decides which devices it connects, what they measure and who can see the results. If it uses ARC Cloud to process personal data
        about other people, for example sensors in someone’s home, the organization is responsible for that data under the DPDP Act, and ARC LABS processes
        it only on the organization’s instructions.
      </p>

      <h2>Who can see it</h2>
      <ul>
        <li>Members of your organization, according to the role it gives them.</li>
        <li>
          ARC LABS platform administrators can see organization names, members and usage figures in order to run the service. They look at device data only
          to give support your organization asks for, to keep the service secure, or when the law requires it.
        </li>
        <li>
          Amazon Web Services hosts ARC Cloud for us, and an email delivery service sends the alert emails you set up. They process data only to provide
          that service to us.
        </li>
        <li>Systems you connect yourself, through webhooks or API keys, receive the data you send them; their own terms apply there.</li>
        <li>Authorities, when a law or court order requires it.</li>
      </ul>

      <h2>Where and how long</h2>
      <ul>
        <li>Stored on Amazon Web Services in Mumbai, India (ap-south-1).</li>
        <li>Device readings: for your organization’s data period (90 days on the free plan), then deleted automatically.</li>
        <li>Server logs: 14 days. Database backups: 7 days, overwritten on a rolling basis.</li>
        <li>Your account: until you ask us to delete it. Leaving or being removed from an organization does not delete your account.</li>
      </ul>

      <h2>How we protect it</h2>
      <p>
        Every connection, from browsers and devices, is encrypted with TLS. The database, server disks and file storage are encrypted at rest, and each
        organization’s data is kept separate at the database level. Every device has its own password, which can be replaced or revoked at any time, and
        devices install only firmware updates ARC LABS has signed. Anyone with physical access to a device may be able to read what is stored on it, so use
        its factory reset before you give it away or send it for repair.
      </p>

      <h2>If there is a data breach</h2>
      <p>
        We will tell affected people without delay what happened, what data was involved and what they can do, and report it to the Data Protection Board
        of India as the DPDP Rules require.
      </p>

      <h2>Your rights</h2>
      <p>
        You can ask for a summary of your personal data and who it was shared with, ask us to correct, complete, update or erase it, withdraw your consent
        (which closes your account), and nominate someone to act for you if you die or become unable to. Ask your organization’s administrator, or ARC LABS
        through the contact details on arclabs.in. We may ask you to confirm who you are first, and we resolve grievances within 90 days. If you are not
        satisfied with our answer, you can complain to the Data Protection Board of India.
      </p>

      <h2>Age</h2>
      <p>ARC Cloud accounts are only for people aged 18 or older. If we learn an account belongs to someone younger, we close it and delete its data.</p>

      <h2>Changes</h2>
      <p>
        When this notice changes, we publish the new version here with its date, and ARC Cloud asks you to accept it before you continue. Until you do, you
        can still sign out or read it.
      </p>
    </>
  );
}

export function PrivacyPage() {
  return (
    <main className="privacy">
      <h1>ARC Cloud privacy notice</h1>
      <p className="muted">Version {PRIVACY_VERSION}</p>
      <PrivacyNotice />
    </main>
  );
}

/** Shown instead of the console when the signed-in person has not accepted the current notice. */
export function TermsGate({ accepted, onAccepted, onSignOut }: { accepted: string | null; onAccepted: () => Promise<void>; onSignOut: () => void }) {
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/auth/accept-terms', { version: PRIVACY_VERSION, accept: true });
      await onAccepted();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <main className="privacy terms-gate">
      <div className="brand">
        <ArcMark size={28} />
        <span>ARC Cloud</span>
      </div>
      <h1>{accepted ? 'Our privacy notice has changed' : 'Please accept our privacy notice'}</h1>
      <p className="muted">
        Version {PRIVACY_VERSION}
        {accepted ? ` (you accepted version ${accepted})` : ''}. Read it, then accept it to continue.
      </p>
      <PrivacyNotice />
      <div className="terms-actions">
        <label className="consent">
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
          <span>I am 18 or older and I agree to this privacy notice.</span>
        </label>
        <ErrorBox error={error} />
        <div className="row">
          <button className="btn primary" disabled={!agree || busy} onClick={accept} type="button">
            {busy ? 'Please wait…' : 'Accept and continue'}
          </button>
          <button className="btn" disabled={busy} onClick={onSignOut} type="button">
            Sign out
          </button>
        </div>
      </div>
    </main>
  );
}
