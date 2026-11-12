/**
 * Account emails (confirm your address, set a new password) as a branded HTML message with one big button, plus
 * the same content as plain text for mail apps that do not show HTML.
 *
 * Email clients ignore <style> blocks and modern CSS, so the layout is tables with inline styles only, and the
 * button is a link styled as a button (works everywhere, including Outlook). Every value from outside (names,
 * links) is HTML-escaped.
 */

const BRAND = '#2f45c5';
const INK = '#14202e';
const MUTED = '#5b6779';
const BG = '#eef1f4';

export interface AccountEmail {
  /** Short line some inboxes show next to the subject. */
  preheader: string;
  heading: string;
  greeting: string;
  intro: string;
  button: { label: string; url: string };
  /** Numbered "what happens next" steps. */
  steps?: string[];
  /** Small print under the button (expiry, "ignore if this wasn't you"). */
  notes: string[];
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const FOOTER = ['This mailbox is not monitored, so please do not reply.', 'ARC LABS, Hyderabad'];

export function renderAccountEmail(m: AccountEmail): { html: string; text: string } {
  const e = escapeHtml;
  const url = e(m.button.url);
  const steps = m.steps?.length
    ? `<tr><td style="padding:8px 40px 0">
         <p style="margin:0 0 10px;font-size:15px;font-weight:600;color:${INK}">What happens next</p>
         <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
           ${m.steps
             .map(
               (s, i) => `<tr>
             <td valign="top" width="34" style="padding:0 0 10px">
               <div style="width:24px;height:24px;border-radius:12px;background:#e6eafb;color:${BRAND};font-size:13px;font-weight:700;line-height:24px;text-align:center">${i + 1}</div>
             </td>
             <td valign="top" style="padding:2px 0 10px;font-size:14px;line-height:1.5;color:${INK}">${e(s)}</td>
           </tr>`,
             )
             .join('')}
         </table>
       </td></tr>`
    : '';

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${e(m.heading)}</title></head>
<body style="margin:0;padding:0;background:${BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${e(m.preheader)}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${BG}">
<tr><td align="center" style="padding:32px 16px">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden">
    <tr><td style="background:${BRAND};background-image:linear-gradient(135deg,#2f45c5,#17b39b);padding:28px 40px">
      <p style="margin:0;font-size:13px;letter-spacing:2px;font-weight:700;color:#cdd6ff">ARC CLOUD</p>
      <h1 style="margin:8px 0 0;font-size:26px;line-height:1.25;font-weight:700;color:#ffffff">${e(m.heading)}</h1>
    </td></tr>
    <tr><td style="padding:32px 40px 8px;font-size:15px;line-height:1.6;color:${INK}">
      <p style="margin:0 0 12px">${e(m.greeting)}</p>
      <p style="margin:0">${e(m.intro)}</p>
    </td></tr>
    <tr><td align="center" style="padding:24px 40px 28px">
      <a href="${url}" target="_blank" rel="noopener" style="display:inline-block;background:${BRAND};color:#ffffff;font-size:16px;font-weight:700;text-decoration:none;padding:15px 34px;border-radius:10px">${e(m.button.label)}</a>
    </td></tr>
    ${steps}
    <tr><td style="padding:12px 40px 28px">
      <div style="border-top:1px solid #e3e7ee;padding-top:18px;font-size:13px;line-height:1.55;color:${MUTED}">
        ${m.notes.map((n) => `<p style="margin:0 0 8px">${e(n)}</p>`).join('')}
        <p style="margin:12px 0 0">Button not working? Copy this link into your browser:<br><a href="${url}" style="color:${BRAND};word-break:break-all">${url}</a></p>
      </div>
    </td></tr>
  </table>
  <p style="margin:18px 0 0;font-size:12px;line-height:1.5;color:${MUTED}">${FOOTER.map(e).join('<br>')}</p>
</td></tr>
</table>
</body></html>`;

  const text = [
    m.greeting,
    '',
    m.intro,
    '',
    `${m.button.label}: ${m.button.url}`,
    ...(m.steps?.length ? ['', 'What happens next:', ...m.steps.map((s, i) => `  ${i + 1}. ${s}`)] : []),
    '',
    ...m.notes,
    '',
    ...FOOTER,
  ].join('\n');

  return { html, text };
}
