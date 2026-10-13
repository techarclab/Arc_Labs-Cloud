import { Link } from 'react-router-dom';
import { ago } from '../format';

export interface Alert {
  id: string;
  projectId: string;
  deviceId: string;
  deviceName?: string;
  projectName?: string;
  ruleId: string | null;
  ruleName: string;
  ruleType: 'threshold' | 'stale' | 'offline';
  severity: 'info' | 'warning' | 'critical';
  status: 'triggered' | 'acknowledged' | 'resolved';
  message: string;
  value: number | null;
  triggeredAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolution: 'recovered' | 'manual' | 'rule_changed' | null;
}

export const SEVERITY_LABEL = { info: 'Info', warning: 'Warning', critical: 'Critical' } as const;
export const STATUS_LABEL = { triggered: 'Needs attention', acknowledged: 'Acknowledged', resolved: 'Resolved' } as const;
export const RESOLUTION_LABEL = { recovered: 'recovered on its own', manual: 'resolved by hand', rule_changed: 'rule changed' } as const;

export function SeverityPill({ s }: { s: Alert['severity'] }) {
  return <span className={`pill sev-${s}`}>{SEVERITY_LABEL[s]}</span>;
}

export function AlertStatus({ a }: { a: Pick<Alert, 'status'> }) {
  return <span className={`astatus ${a.status}`}>{STATUS_LABEL[a.status]}</span>;
}

/** Compact alert rows for the overview and channel pages. */
export function AlertList({ orgId, items, now, empty }: { orgId: string; items: Alert[]; now: number; empty: string }) {
  if (!items.length) return <p className="muted small" style={{ padding: '14px 18px' }}>{empty}</p>;
  return (
    <ul className="alert-list">
      {items.map((a) => (
        <li key={a.id} className={a.status}>
          <Link to={`/o/${orgId}/alerts/${a.id}`}>
            <span className={`sev-bar sev-${a.severity}`} aria-hidden />
            <span className="alert-main">
              <b>{a.ruleName}</b> · {a.deviceName}
              <span className="muted small"> — {a.message}</span>
            </span>
            <span className="alert-meta">
              <AlertStatus a={a} />
              <span className="muted small">{ago(a.triggeredAt, now)}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
