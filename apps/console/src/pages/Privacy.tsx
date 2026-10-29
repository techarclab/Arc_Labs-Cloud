/**
 * Privacy notice shown at sign-up (version must match TERMS_VERSION in apps/api/src/common/invites.ts).
 * Every statement describes how this deployment actually works; update both when anything below changes.
 */
export const PRIVACY_VERSION = '2026-10-29';

export function PrivacyPage() {
  return (
    <main className="privacy">
      <h1>ARC Cloud privacy notice</h1>
      <p className="muted">Version {PRIVACY_VERSION}</p>
      <p>
        ARC Cloud is operated by ARC LABS, Hyderabad. This notice explains what personal data ARC Cloud keeps about you when you use it, why, for how long,
        and what you can ask us to do with it, in line with India’s Digital Personal Data Protection Act, 2023.
      </p>

      <h2>What we keep</h2>
      <ul>
        <li>
          <b>Your account:</b> name, email address, your password (stored only as a salted scrypt hash, never in readable form), the organizations you
          belong to and your role in each, and when you accepted this notice.
        </li>
        <li>
          <b>What your devices send:</b> readings, device state, firmware versions, commands and alerts, in the organization you send them to.
        </li>
        <li>
          <b>Security records:</b> an audit log of actions such as sign-ups, sign-ins, changes and deletions, and server logs including IP addresses.
        </li>
        <li>
          <b>In your browser:</b> your sign-in token and your last opened channel, stored in your browser’s local storage. No advertising or tracking
          cookies.
        </li>
      </ul>

      <h2>Why</h2>
      <p>
        Only to run ARC Cloud for you: to show your data, run your alerts, commands and firmware updates, keep accounts and devices secure, and give
        support. We do not sell your data or use it for advertising.
      </p>

      <h2>Where and how long</h2>
      <ul>
        <li>Stored on Amazon Web Services in Mumbai, India (ap-south-1).</li>
        <li>Device readings: for your organization’s data period (90 days on the free plan), then deleted automatically.</li>
        <li>Server logs: 14 days. Database backups: 7 days.</li>
        <li>Your account: until you ask us to delete it, or your organization removes it.</li>
      </ul>

      <h2>Who can see it</h2>
      <p>
        Members of your organization, according to their role. ARC LABS administrators can see organizations and usage figures to run the service, and
        access your devices’ data only to give support you ask for, or when the law requires it.
      </p>

      <h2>Your rights</h2>
      <p>
        You can ask for a copy of your personal data, to correct it, or to erase it, and you can withdraw your consent (which closes your account). Contact
        your organization’s administrator, or ARC LABS through the contact details on arclabs.in. If you are not satisfied with our answer, you can
        complain to the Data Protection Board of India.
      </p>

      <h2>Age</h2>
      <p>ARC Cloud accounts are for people aged 18 or older.</p>

      <h2>Changes</h2>
      <p>If this notice changes, we will show the new version and its date here and ask you to accept it again when the change matters.</p>
    </main>
  );
}
