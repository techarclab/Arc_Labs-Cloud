export type ConnectivityStatus = 'online' | 'offline' | 'unknown';
export type ConnectivitySource = 'broker_event' | 'last_seen' | 'none';

export interface ConnectivityInput {
  now: Date;
  lastSeenAt: Date | null;
  lastConnectedAt: Date | null;
  lastDisconnectedAt: Date | null;
  /** Expected reporting interval for this device class, in seconds. */
  expectedIntervalSeconds: number;
  graceSeconds?: number;
}

export interface Connectivity {
  status: ConnectivityStatus;
  source: ConnectivitySource;
  thresholdSeconds: number;
}

/**
 * Online/offline per design plan §9:
 *  - A broker disconnect newer than the last connect and last message => offline.
 *  - Otherwise a message within (interval × 3 + grace) => online.
 *  - Never reported => unknown.
 */
export function computeConnectivity(input: ConnectivityInput): Connectivity {
  const grace = input.graceSeconds ?? 30;
  const thresholdSeconds = input.expectedIntervalSeconds * 3 + grace;
  const t = (d: Date | null) => (d ? d.getTime() : -Infinity);

  if (!input.lastSeenAt && !input.lastConnectedAt) {
    return { status: 'unknown', source: 'none', thresholdSeconds };
  }

  const latestActivity = Math.max(t(input.lastSeenAt), t(input.lastConnectedAt));
  if (input.lastDisconnectedAt && t(input.lastDisconnectedAt) > latestActivity) {
    return { status: 'offline', source: 'broker_event', thresholdSeconds };
  }

  const ageSeconds = (input.now.getTime() - latestActivity) / 1000;
  if (ageSeconds <= thresholdSeconds) {
    const source: ConnectivitySource = t(input.lastConnectedAt) >= t(input.lastSeenAt) ? 'broker_event' : 'last_seen';
    return { status: 'online', source, thresholdSeconds };
  }
  return { status: 'offline', source: 'last_seen', thresholdSeconds };
}
