export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function num(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  const digits = abs >= 1000 ? 0 : abs >= 100 ? 1 : 2;
  return v.toLocaleString(undefined, { maximumFractionDigits: digits });
}

/** "temperatureC" → "Temperature C", "humidityPct" → "Humidity %" */
const UNIT_SUFFIX: [RegExp, string, string][] = [
  [/C$/, '°C', ''],
  [/Pct$/, '%', ''],
  [/Dbm$/, 'dBm', ''],
  [/Hpa$/, 'hPa', ''],
  [/V$/, 'V', ''],
  [/Ma$/, 'mA', ''],
  [/Lux$/, 'lux', ''],
  [/Ppm$/, 'ppm', ''],
];
const KNOWN: Record<string, { label: string; unit: string }> = {
  rssiDbm: { label: 'Wi-Fi signal', unit: 'dBm' },
  rssi: { label: 'Wi-Fi signal', unit: 'dBm' },
  uptimeS: { label: 'Uptime', unit: 's' },
  freeHeap: { label: 'Free memory', unit: 'bytes' },
  firmwareVersion: { label: 'Firmware', unit: '' },
  batteryV: { label: 'Battery', unit: 'V' },
  batteryPct: { label: 'Battery', unit: '%' },
};
export function metricLabel(key: string, defs?: { metricKey: string; label: string; unit: string }[]) {
  const def = defs?.find((d) => d.metricKey === key);
  if (def) return { label: def.label, unit: def.unit };
  if (KNOWN[key]) return KNOWN[key];
  let base = key;
  let unit = '';
  for (const [re, u] of UNIT_SUFFIX) {
    if (re.test(key) && key.length > 2) {
      base = key.replace(re, '');
      unit = u;
      break;
    }
  }
  const label = base.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
  return { label: label.charAt(0).toUpperCase() + label.slice(1), unit };
}

export function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export function download(filename: string, text: string) {
  const blob = new Blob([text], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 0);
}
