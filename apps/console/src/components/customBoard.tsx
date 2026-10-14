/**
 * Custom board: a dashboard widget whose look is the user's own HTML and CSS.
 *
 * Live values go in with placeholders such as {{temperature}} or {{field1.unit}}. The result is
 * shown in a sandboxed iframe with no scripts and a strict content policy, so a board can't run
 * code, read the session or call the API; it can only display the values we fill in (escaped).
 */
import { useMemo, useState } from 'react';
import { Device, Field, Reading } from '../api';
import { ago } from '../format';

export interface BoardData {
  fields: Field[];
  latest: Map<string, Reading>;
  controls: Map<string, number>;
  device?: Device;
  now: number;
}

export interface BoardTemplate {
  id: string;
  name: string;
  help: string;
  height: number;
  make: (fields: Field[]) => { html: string; css: string };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function fieldFor(fields: Field[], name: string): Field | undefined {
  const m = /^field(\d{1,2})$/.exec(name);
  return fields.find((f) => f.metricKey === name) ?? (m ? fields.find((f) => f.position === Number(m[1])) : undefined);
}

/** Replaces {{name}} and {{name.part}} with escaped live values. Unknown names become "—". */
export function fillBoard(template: string, d: BoardData): string {
  return template.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)(?:\.([a-z]+))?\s*\}\}/g, (_all, name: string, part = 'value') => {
    if (name === 'device') {
      const dev = d.device;
      if (!dev) return '—';
      if (part === 'name' || part === 'value') return esc(dev.displayName);
      if (part === 'status') return esc(dev.connectivity.status);
      if (part === 'seen') return dev.lastSeenAt ? esc(ago(dev.lastSeenAt, d.now)) : 'never';
      return '—';
    }
    if (name === 'now') return esc(new Date(d.now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    const f = fieldFor(d.fields, name);
    if (!f) return '—';
    const key = f.metricKey;
    const r = d.latest.get(key);
    const v = f.kind === 'control' ? d.controls.get(key) : r?.value;
    switch (part) {
      case 'label':
        return esc(f.label);
      case 'unit':
        return esc(f.unit);
      case 'time':
        return r ? esc(ago(r.ts, d.now)) : f.kind === 'control' ? '' : 'no data';
      case 'raw':
        return v === undefined ? '' : String(v);
      case 'on':
        return v === undefined ? 'unset' : v !== 0 ? 'on' : 'off';
      case 'percent': {
        if (v === undefined) return '0';
        const lo = f.minValue ?? 0;
        const hi = f.maxValue ?? 100;
        return String(Math.round(Math.min(1, Math.max(0, (v - lo) / (hi - lo || 1))) * 100));
      }
      case 'value':
        return v === undefined ? '—' : esc(v.toFixed(f.decimals ?? 2));
      default:
        return '—';
    }
  });
}

const BASE_CSS = `*,*::before,*::after{box-sizing:border-box}html,body{margin:0;height:100%}
body{font:15px/1.45 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#142033;font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}`;
const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; font-src data: https:";

export function boardDocument(html: string, css: string, d: BoardData): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><style>${BASE_CSS}</style><style>${css.replace(/<\/style/gi, '')}</style></head><body>${fillBoard(html, d)}</body></html>`;
}

export function BoardFrame({ html, css, height, data, title }: { html: string; css: string; height: number; data: BoardData; title: string }) {
  const doc = useMemo(() => boardDocument(html, css, data), [html, css, data]);
  return <iframe className="board-frame" title={title || 'Custom board'} sandbox="" srcDoc={doc} style={{ height: Math.min(1200, Math.max(80, height || 220)) }} />;
}

// ------------------------------------------------------------------ ready-made templates

const pick = (fields: Field[]) => {
  const data = fields.filter((f) => f.kind === 'data');
  const ctrl = fields.filter((f) => f.kind === 'control');
  return { a: data[0]?.metricKey ?? 'field1', b: data[1]?.metricKey ?? data[0]?.metricKey ?? 'field2', data, c: ctrl[0]?.metricKey ?? 'led' };
};

export const BOARD_TEMPLATES: BoardTemplate[] = [
  {
    id: 'hero',
    name: 'Hero reading',
    help: 'One big live value on a colour gradient.',
    height: 210,
    make: (fields) => {
      const { a } = pick(fields);
      return {
        html: `<div class="hero">
  <div class="top">
    <span class="dot {{device.status}}"></span>
    <span>{{device.name}}</span>
  </div>
  <div class="label">{{${a}.label}}</div>
  <div class="value">{{${a}}}<small>{{${a}.unit}}</small></div>
  <div class="when">Updated {{${a}.time}}</div>
</div>`,
        css: `.hero {
  height: 100%; padding: 20px 22px; border-radius: 14px; color: #fff;
  background: radial-gradient(120% 140% at 0% 0%, #3157f6 0%, #6a3df0 45%, #0e1726 100%);
  display: flex; flex-direction: column;
}
.top { display: flex; align-items: center; gap: 8px; font-size: 13px; opacity: .85; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #8a96a3; }
.dot.online { background: #3ef0c8; box-shadow: 0 0 10px #3ef0c8; }
.dot.offline { background: #ff6b5e; }
.label { margin-top: auto; font-size: 14px; opacity: .8; }
.value { font-size: 56px; font-weight: 750; letter-spacing: -.03em; line-height: 1; }
.value small { font-size: 20px; font-weight: 500; margin-left: 6px; opacity: .75; }
.when { font-size: 12px; opacity: .65; margin-top: 8px; }`,
      };
    },
  },
  {
    id: 'room',
    name: 'Room monitor',
    help: 'Two readings side by side with fill bars.',
    height: 190,
    make: (fields) => {
      const { a, b } = pick(fields);
      const tile = (k: string, cls: string) => `  <div class="tile ${cls}">
    <div class="label">{{${k}.label}}</div>
    <div class="value">{{${k}}} <small>{{${k}.unit}}</small></div>
    <div class="bar"><i style="width: {{${k}.percent}}%"></i></div>
  </div>`;
      return {
        html: `<div class="room">\n${tile(a, 'warm')}\n${tile(b, 'cool')}\n</div>`,
        css: `.room { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; height: 100%; padding: 2px; }
.tile { border-radius: 14px; padding: 16px 18px; display: flex; flex-direction: column; justify-content: space-between; }
.warm { background: linear-gradient(160deg, #fff4e6, #ffe1c2); color: #7a3d00; }
.cool { background: linear-gradient(160deg, #e6f6ff, #c9e9ff); color: #0b4a72; }
.label { font-size: 13px; font-weight: 600; opacity: .8; }
.value { font-size: 36px; font-weight: 750; letter-spacing: -.02em; }
.value small { font-size: 15px; font-weight: 500; opacity: .7; }
.bar { height: 8px; border-radius: 99px; background: rgba(255,255,255,.7); overflow: hidden; }
.bar i { display: block; height: 100%; border-radius: 99px; background: currentColor; opacity: .75; }`,
      };
    },
  },
  {
    id: 'board',
    name: 'Lab board',
    help: 'Every sensor field in a dark instrument panel.',
    height: 260,
    make: (fields) => {
      const { data } = pick(fields);
      const rows = (data.length ? data.slice(0, 6).map((f) => f.metricKey) : ['field1', 'field2'])
        .map((k) => `    <li><span>{{${k}.label}}</span><b>{{${k}}}<small>{{${k}.unit}}</small></b></li>`)
        .join('\n');
      return {
        html: `<div class="panel">
  <header>
    <b>{{device.name}}</b>
    <span class="state {{device.status}}">{{device.status}}</span>
  </header>
  <ul>
${rows}
  </ul>
  <footer>Last message {{device.seen}} · {{now}}</footer>
</div>`,
        css: `.panel { height: 100%; background: #0e1726; color: #d7e0ee; border-radius: 14px; padding: 16px 18px; display: flex; flex-direction: column;
  background-image: radial-gradient(rgba(255,255,255,.06) 1px, transparent 1.2px); background-size: 18px 18px; }
header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
header b { color: #fff; font-size: 15px; }
.state { font-size: 12px; padding: 2px 10px; border-radius: 99px; background: #22324f; text-transform: capitalize; }
.state.online { background: #0f3d36; color: #5ff0d0; }
.state.offline { background: #4a1d1a; color: #ff9a90; }
ul { list-style: none; margin: 0; padding: 0; flex: 1; }
li { display: flex; justify-content: space-between; align-items: baseline; padding: 7px 0; border-bottom: 1px dashed #22324f; }
li span { color: #8fa1bd; font-size: 13.5px; }
li b { font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace; font-size: 18px; color: #fff; }
li small { font-size: 12px; color: #8fa1bd; margin-left: 4px; }
footer { font-size: 11.5px; color: #6f81a0; margin-top: 8px; }`,
      };
    },
  },
  {
    id: 'control',
    name: 'Control status',
    help: 'Shows whether a control (like the LED) is on or off.',
    height: 150,
    make: (fields) => {
      const { c } = pick(fields);
      if (!fields.some((f) => f.kind === 'control')) {
        return {
          html: `<div class="lamp unset">
  <div class="bulb"></div>
  <div>
    <div class="label">No control field yet</div>
    <div class="hint">Add a field with kind <b>Control</b> (for example <code>led</code>) in Channel settings, then pick this template again.</div>
  </div>
</div>`,
          css: `.lamp { height: 100%; display: flex; align-items: center; gap: 20px; padding: 18px 22px; border-radius: 14px; background: #f1f4f8; }
.bulb { width: 64px; height: 64px; flex: none; border-radius: 50%; background: #cfd6de; border: 4px solid #e2e7ed; }
.label { font-weight: 700; color: #33415a; }
.hint { font-size: 13px; color: #5d6b80; margin-top: 4px; }`,
        };
      }
      return {
        html: `<div class="lamp {{${c}.on}}">
  <div class="bulb"></div>
  <div>
    <div class="label">{{${c}.label}}</div>
    <div class="state">{{${c}.on}}</div>
  </div>
</div>`,
        css: `.lamp { height: 100%; display: flex; align-items: center; gap: 20px; padding: 18px 22px; border-radius: 14px; background: #f1f4f8; }
.bulb { width: 64px; height: 64px; border-radius: 50%; background: #cfd6de; border: 4px solid #e2e7ed; transition: all .3s; }
.label { font-size: 13px; color: #5d6b80; font-weight: 600; }
.state { font-size: 30px; font-weight: 750; text-transform: uppercase; letter-spacing: .02em; color: #33415a; }
.lamp.on { background: linear-gradient(135deg, #fff8e1, #ffe9a8); }
.lamp.on .bulb { background: #ffc531; border-color: #ffe7a0; box-shadow: 0 0 0 8px rgba(255,197,49,.25), 0 0 40px #ffc531; }
.lamp.on .state { color: #8a5a00; }
.lamp.unset .state::after { content: ' (not set)'; font-size: 14px; text-transform: none; font-weight: 500; }`,
      };
    },
  },
  {
    id: 'blank',
    name: 'Blank',
    help: 'Start from scratch.',
    height: 200,
    make: (fields) => {
      const { a } = pick(fields);
      return {
        html: `<div class="card">
  <h2>{{${a}.label}}</h2>
  <p class="big">{{${a}}} {{${a}.unit}}</p>
</div>`,
        css: `.card { padding: 16px; }
h2 { margin: 0 0 6px; font-size: 16px; }
.big { margin: 0; font-size: 40px; font-weight: 700; }`,
      };
    },
  },
];

/** The placeholder cheat sheet shown in the editor. */
export function PlaceholderHelp({ fields }: { fields: Field[] }) {
  const [open, setOpen] = useState(false);
  const ex = fields.find((f) => f.kind === 'data')?.metricKey ?? 'temperature';
  const ctl = fields.find((f) => f.kind === 'control')?.metricKey ?? 'led';
  return (
    <div className="ph-help">
      <button type="button" className="btn small quiet" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? 'Hide' : 'Show'} placeholders for live values
      </button>
      {open && (
        <div className="ph-body">
          <table className="grid">
            <tbody>
              <tr><td><code>{`{{${ex}}}`}</code></td><td>Latest value, rounded to the field’s decimals</td></tr>
              <tr><td><code>{`{{${ex}.unit}}`}</code> <code>{`{{${ex}.label}}`}</code></td><td>The field’s unit and label</td></tr>
              <tr><td><code>{`{{${ex}.time}}`}</code></td><td>How long ago it was sent, e.g. “12 s ago”</td></tr>
              <tr><td><code>{`{{${ex}.percent}}`}</code></td><td>0–100 between the field’s min and max, for bars: <code>{`style="width:{{${ex}.percent}}%"`}</code></td></tr>
              <tr><td><code>{`{{${ex}.raw}}`}</code></td><td>The unrounded number</td></tr>
              <tr><td><code>{`{{${ctl}.on}}`}</code></td><td><code>on</code>, <code>off</code> or <code>unset</code>, handy as a CSS class</td></tr>
              <tr><td><code>{'{{device.name}}'}</code> <code>{'{{device.status}}'}</code> <code>{'{{device.seen}}'}</code></td><td>Device name, online/offline/unknown, last message</td></tr>
              <tr><td><code>{'{{now}}'}</code></td><td>Current time</td></tr>
            </tbody>
          </table>
          <p className="small muted">
            Use a field’s firmware name or <code>fieldN</code>. Your fields: {fields.map((f) => <code key={f.metricKey} className="ph-chip">{f.metricKey}</code>)}
          </p>
          <p className="small muted">Scripts don’t run in boards, and pictures load only from https:// or data: addresses.</p>
        </div>
      )}
    </div>
  );
}
