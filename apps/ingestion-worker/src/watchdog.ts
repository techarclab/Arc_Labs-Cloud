/**
 * Detects a subscription that the broker silently stopped serving: the worker publishes a probe to
 * INGEST_PROBE_TOPIC every `intervalMs` and must receive it back through its own telemetry subscription.
 * No probe for `staleAfterMs` while connected → stalled (DEF-014: after an EMQX restart the worker could stay
 * "connected and subscribed" while receiving nothing, until the next broker restart).
 */
export class SubscriptionWatchdog {
  private since = 0; // last connect or last probe received, whichever is later
  private connected = false;

  constructor(
    readonly intervalMs: number,
    readonly staleAfterMs: number,
  ) {
    if (staleAfterMs < 2 * intervalMs) throw new Error('staleAfterMs must allow at least two probe intervals');
  }

  onConnect(now: number) {
    this.connected = true;
    this.since = now;
  }

  onDisconnect() {
    this.connected = false;
  }

  onProbe(now: number) {
    this.since = Math.max(this.since, now);
  }

  /** True when connected and no probe has come back for staleAfterMs. */
  stalled(now: number): boolean {
    return this.connected && now - this.since > this.staleAfterMs;
  }

  /** Milliseconds since the last connect or probe (for /metrics). */
  silenceMs(now: number): number {
    return this.connected ? now - this.since : 0;
  }
}
