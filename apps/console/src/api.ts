// Thin client for the ARC Cloud REST API (/api/v1).
// Locally (Vite dev server, Docker nginx) the API is on the same origin and /api is forwarded.
// When the console is hosted separately (e.g. Vercel), set VITE_API_URL to the API's address at build time.
export const API_ORIGIN = import.meta.env.VITE_API_URL?.replace(/\/+$/, '') || window.location.origin;

/**
 * The access token lives only in memory (a page script that got in could not read it from storage afterwards).
 * A reload renews it from the httpOnly refresh cookie (POST /auth/refresh), so people stay signed in.
 */
let accessToken: string | null = null;
// Older consoles kept the token in localStorage: remove it.
try {
  localStorage.removeItem('arc.token');
} catch {
  /* ignore */
}

// A learner link (/lab#token) uses its own short-lived token without touching the signed-in session.
let tokenOverride: string | null = null;
export function setTokenOverride(t: string | null) {
  tokenOverride = t;
}

export function getToken(): string | null {
  return tokenOverride ?? accessToken;
}
export function setToken(token: string | null) {
  accessToken = token;
}

let refreshing: Promise<boolean> | null = null;
/** Gets a new access token with the session cookie. One request at a time; false when there is no live session. */
export function refreshAccessToken(): Promise<boolean> {
  refreshing ??= fetch(`${API_ORIGIN}/api/v1/auth/refresh`, { method: 'POST', credentials: 'include' })
    .then(async (r) => {
      if (!r.ok) return false;
      accessToken = (await r.json()).accessToken ?? null;
      return !!accessToken;
    })
    .catch(() => false)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

/** Ends this browser's session on the server (and clears the cookie). */
export async function logout() {
  accessToken = null;
  await fetch(`${API_ORIGIN}/api/v1/auth/logout`, { method: 'POST', credentials: 'include' }).catch(() => undefined);
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
  owner_role: 'The owner can’t be changed or removed. The owner can transfer ownership to an admin.',
  owner_only: 'Only the owner can do this.',
  transfer_needs_admin: 'Make them an admin first, then transfer ownership.',
  role_not_assignable: 'Only the owner can add, promote or remove admins.',
  setup_code_invalid: 'That setup code isn’t valid: it may have been used, revoked, or expired. Ask ARC LABS for a new one.',
  setup_code_email_mismatch: 'That setup code was issued for a different email address. Sign in with that address, or ask ARC LABS.',
  org_type_required: 'Choose what kind of organization this is.',
  not_scoped: 'Their role already sees every channel. Channel access is for teachers, trainers, students and employees.',
  channels_for_scoped_roles: 'Only teachers, trainers, students and employees get channels; other roles see every channel.',
  support_read_only: 'Support access is read-only: ARC LABS staff can look, not change anything.',
  use_support_access: 'To look at this organization, open support access from the Platform page.',
  seats_full: 'This organization has no free seats. An owner or admin can raise the limit or remove someone.',
  use_invitations: 'Invite people instead: they join when they accept the invitation.',
  invite_email_mismatch: 'This invitation is for a different email address. Sign in with the address it was sent to.',
  invite_limit: 'Too many invitations today for this organization. Try again tomorrow.',
  seat_limit_above_plan: 'Your plan allows fewer members than that. Ask ARC LABS for more.',
  personal_workspace: 'A personal workspace is just you. For a team, ask ARC LABS to set up an organization.',
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
  sole_admin: 'You own an organization. Transfer ownership to an admin there first, or ask ARC LABS to close it.',
  platform_admin_delete: 'ARC LABS staff accounts must have platform admin removed before they can be deleted.',
  account_type_set: 'You have already said who this account is for. Reload the page.',
  org_suspended: 'This organization is suspended. Contact ARC LABS.',
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

export async function api<T = any>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(`${API_ORIGIN}/api/v1${path}`, {
      method,
      // Sign-in responses set the refresh cookie; it is only ever sent back to /api/v1/auth.
      credentials: 'include',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network', unreachableMessage(), null);
  }
  // The access token expired (they last minutes): renew it from the session cookie once, then try again.
  if (res.status === 401 && token && !tokenOverride && !retried && (await refreshAccessToken())) return api<T>(method, path, body, true);
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

/** A person's role in an organization (the API's organization_members.role). */
export type Role = 'owner' | 'admin' | 'teacher' | 'trainer' | 'engineer' | 'student' | 'employee' | 'viewer' | 'individual' | 'support';
/** kind 'personal': someone's own free workspace; 'organization': set up by ARC LABS. */
/** support: ARC LABS staff looking in with time-limited, read-only support access (until `until`). */
export interface Org { id: string; name: string; slug: string; role?: Role; kind?: 'personal' | 'organization'; support?: { id: string; until: string } }
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

export const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  teacher: 'Teacher',
  trainer: 'Trainer',
  engineer: 'Engineer',
  student: 'Student',
  employee: 'Employee',
  viewer: 'Viewer',
  individual: 'Personal workspace',
  support: 'ARC LABS support (read-only)',
};
/** The API's access levels (AccessService.LEVEL): what a role may do across the organization. */
const LEVEL: Record<Role, 1 | 2 | 3> = { owner: 3, admin: 3, individual: 3, teacher: 2, trainer: 2, engineer: 2, student: 1, employee: 1, viewer: 1, support: 1 };
/** Can change channels, devices, rules (engineer level and up). */
export const canEdit = (r?: Role) => !!r && LEVEL[r] >= 2;
/** Admin-level settings: API keys, webhooks, firmware, audit log (owner, admin, and the individual in their workspace). */
export const isAdmin = (r?: Role) => !!r && LEVEL[r] >= 3;
/** Roles limited to the channels granted to them (no organization-wide pages). Mirrors AccessService.SCOPED_ROLES. */
export const isScoped = (r?: Role) => r === 'teacher' || r === 'trainer' || r === 'student' || r === 'employee';
/** Who manages a channel's access list: the owner, admins, and the channel's teachers and trainers. */
export const canManageAccess = (r?: Role) => r === 'owner' || r === 'admin' || r === 'teacher' || r === 'trainer';
/** People management exists only in organizations, for the owner and admins. */
export const canManageTeam = (org?: Org) => org?.kind !== 'personal' && (org?.role === 'owner' || org?.role === 'admin');
/** Roles this caller may give (mirrors AccessService.canAssign): only the owner deals with admins. */
export const assignableRoles = (caller?: Role): Role[] =>
  caller === 'owner'
    ? ['admin', 'teacher', 'trainer', 'engineer', 'student', 'employee', 'viewer']
    : caller === 'admin'
      ? ['teacher', 'trainer', 'engineer', 'student', 'employee', 'viewer']
      : caller === 'teacher' || caller === 'trainer'
        ? ['student']
        : [];

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
