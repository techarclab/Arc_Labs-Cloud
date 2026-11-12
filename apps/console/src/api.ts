// Thin client for the ARC Cloud REST API (/api/v1).
// Locally (Vite dev server, Docker nginx) the API is on the same origin and /api is forwarded.
// When the console is hosted separately (e.g. Vercel), set VITE_API_URL to the API's address at build time.
export const API_ORIGIN = import.meta.env.VITE_API_URL?.replace(/\/+$/, '') || window.location.origin;

const TOKEN_KEY = 'arc.token';

// A learner link (/lab#token) uses its own short-lived token without touching the signed-in session.
let tokenOverride: string | null = null;
export function setTokenOverride(t: string | null) {
  tokenOverride = t;
}

export function getToken(): string | null {
  if (tokenOverride) return tokenOverride;
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: session lasts until reload */
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public body: unknown,
  ) {
    super(message);
  }
}

const listeners = new Set<() => void>();
export const onUnauthorized = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

const MESSAGES: Record<string, string> = {
  invalid_credentials: 'That email and password don’t match an account.',
  invalid_google_credential: 'Google could not verify this sign-in. Please try again.',
  google_account_link_conflict: 'This Google account is linked to a different ARC Cloud account.',
  google_signin_unconfigured: 'Google sign-in is not configured on this server yet.',
  account_disabled: 'This account has been disabled. Contact an administrator.',
  email_taken: 'An account with this email already exists. Sign in instead.',
  slug_taken: 'That short name is already used by another organization. Try a different one.',
  insufficient_role: 'Your role in this organization doesn’t allow this. Ask an admin.',
  last_admin: 'An organization needs at least one admin. Make someone else an admin first.',
  user_not_found: 'No ARC Cloud account uses that email. Ask them to sign up first, then add them.',
  device_revoked: 'This device has been revoked, so its password can’t be replaced.',
  terminal_state: 'This device is revoked or retired and can’t be changed.',
  signup_disabled: 'New sign-ups are turned off on this server.',
  invite_required: 'Creating an account needs an invite code from ARC LABS. Ask your instructor or your ARC LABS contact.',
  terms_version_changed: 'The privacy notice was updated while this page was open. Reload the page and read the new version.',
  person_required: 'Only a signed-in person can accept the privacy notice, not an API key.',
  invite_invalid: 'That invite code isn’t valid. Check for typos; it may also have expired, been revoked or been used up.',
  organization_needs_invite: 'Joining an organization needs an invite code from ARC LABS. Ask your instructor or ARC LABS contact, or choose “Just me” to start on the free plan.',
  invite_not_for_organization: 'That code doesn’t join an organization. Check for typos; it may have expired or been used up. Ask ARC LABS for your organization’s code, or choose “Just me”.',
  confirm_email_mismatch: 'Type your account’s email address exactly to confirm.',
  sole_admin: 'You are the only admin of an organization with other members. Make someone else an admin there first.',
  platform_admin_delete: 'ARC LABS staff accounts must have platform admin removed before they can be deleted.',
  account_type_set: 'You have already said who this account is for. Reload the page.',
  minor_needs_invite: 'Under 18? You can join with an invite code from your college or school. Ask your instructor for one.',
  email_unverified: 'Confirm your email address first: open the link we emailed you.',
  profile_incomplete: 'Finish setting up your account first.',
  verification_invalid: 'This confirmation link is invalid, already used, or expired. Sign in and ask for a new one.',
  resend_too_soon: 'We just sent a link. Wait a minute before asking again.',
  resend_limit: 'Too many links today. Try again tomorrow, or contact ARC LABS.',
  already_member: 'You are already a member of that organization.',
  profile_complete: 'Your account is already set up. Reload the page.',
  reset_invalid: 'This password link is invalid, already used, or expired. Ask for a new one from the sign-in page.',
  session_revoked: 'You were signed out because the password was changed. Sign in again.',
  platform_admin_only: 'Only ARC LABS administrators can do this.',
  not_found: 'Not found, or you don’t have access to it.',
  not_a_control: 'That field isn’t a control field.',
  device_inactive: 'This device is suspended, revoked or retired.',
};

function isLocal() {
  return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);
}

function unreachableMessage() {
  if (isLocal()) return 'Can’t reach the ARC Cloud server. Check that Docker is running.';
  if (!import.meta.env.VITE_API_URL)
    return 'This console isn’t connected to an ARC Cloud server yet. Set VITE_API_URL to the server’s address and redeploy.';
  return `Can’t reach the ARC Cloud server at ${API_ORIGIN}. It may be starting up or offline — try again in a minute.`;
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(`${API_ORIGIN}/api/v1${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network', unreachableMessage(), null);
  }
  // A hosted console with no API behind it gets the page HTML (or a 404/405) instead of JSON.
  const isJson = (res.headers.get('content-type') ?? '').includes('json');
  if (!isJson && res.status !== 204 && !import.meta.env.VITE_API_URL && !isLocal()) {
    throw new ApiError(0, 'network', unreachableMessage(), null);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    if (res.status === 401 && token && !tokenOverride) {
      setToken(null);
      listeners.forEach((l) => l());
    }
    const code = data?.code ?? data?.message?.code ?? `http_${res.status}`;
    let message = MESSAGES[code] ?? (typeof data?.message === 'string' ? data.message : undefined);
    if (!message && code === 'validation_failed') {
      message = (data.issues ?? []).map((i: any) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('\n');
    }
    if (!message && res.status === 429) message = 'Too many attempts. Wait a minute and try again.';
    throw new ApiError(res.status, code, message || `Request failed (${res.status}).`, data);
  }
  return data as T;
}

// ---- Types (mirror the API responses) ----

export type Role = 'org_admin' | 'engineer' | 'viewer';
/** kind 'personal': someone's own free workspace; 'organization': set up by ARC LABS. */
export interface Org { id: string; name: string; slug: string; role?: Role; kind?: 'personal' | 'organization' }
export interface Project { id: string; organizationId: string; name: string; description: string; timezone: string; readApiKey: string; deviceCount?: number }
export interface Connectivity { status: 'online' | 'offline' | 'unknown'; source: string; thresholdSeconds: number }
export interface Device {
  id: string;
  connection?: { mqttHost: string; mqttPort: number; topicBase: string };
  organizationId: string;
  projectId: string;
  displayName: string;
  deviceType: string;
  model: string;
  firmwareVersion: string | null;
  tags: string[];
  lifecycleStatus: string;
  expectedIntervalSeconds: number;
  connectivity: Connectivity;
  reportedState: Record<string, unknown>;
  createdAt: string;
  lastSeenAt: string | null;
  lastConnectedAt: string | null;
  lastDisconnectedAt: string | null;
}
export interface Credentials {
  mqttHost: string;
  mqttPort: number;
  tls: boolean;
  clientId: string;
  username: string;
  password: string;
  topics: { telemetry: string; state: string; commands?: string; commandAcks?: string };
  http?: { apiKey: string; updateUrl: string; controlsUrl: string };
}
export interface Reading { metric: string; value: number; ts: string }
export interface MetricDef {
  metricKey: string;
  label: string;
  unit: string;
  minValue: number | null;
  maxValue: number | null;
  position: number;
  kind: 'data' | 'control';
  decimals: number;
  step: number | null;
}
export type Field = MetricDef;
export interface Control { field: string; value: number; updatedAt: string }
export type WidgetType = string;
export interface Widget {
  id: string;
  type: WidgetType;
  title: string;
  field: string;
  size: 's' | 'm' | 'l' | 'xl';
  options: Record<string, string | number | boolean | null>;
}

export const ROLE_LABEL: Record<Role, string> = { org_admin: 'Admin', engineer: 'Engineer', viewer: 'Viewer' };
export const canEdit = (r?: Role) => r === 'org_admin' || r === 'engineer';
export const isAdmin = (r?: Role) => r === 'org_admin';

/** Fetch a file with the session token and save it (used for CSV export). */
export async function downloadAuthed(path: string, filename: string) {
  const res = await fetch(`${API_ORIGIN}${path}`, { headers: { authorization: `Bearer ${getToken() ?? ''}` } });
  if (!res.ok) throw new ApiError(res.status, `http_${res.status}`, 'Download failed.', null);
  const blob = await res.blob();
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
