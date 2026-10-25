#!/bin/bash
# Weekly security patching of the Amazon Linux 2023 host (run by arc-os-patch.timer; manual: sudo arc-os-patch).
#
# Why --releasever=latest: AL2023 locks dnf to the repository version the AMI shipped with ("deterministic
# upgrades"), so a plain `dnf upgrade` (or dnf-automatic) never sees newer security fixes. AWS recommends
# replacing the instance from a new AMI or Patch Manager for fleets; for this single pilot server we apply
# security advisories in place, accepting that an OS update is first tested on this host.
#
# Reboots only when dnf says the kernel or core libraries changed. Containers come back by themselves
# (restart: unless-stopped); devices reconnect. Expect ~2 minutes of downtime on those Sundays.
#   arc-os-patch [--no-reboot]
set -euo pipefail
log() { echo "[arc-os-patch] $*"; }

REBOOT=1
[ "${1:-}" = "--no-reboot" ] && REBOOT=0
[ "$(id -u)" -eq 0 ] || { echo "arc-os-patch must run as root" >&2; exit 1; }

log "current release: $(rpm -q --qf '%{VERSION}' system-release)"
log "pending security advisories:"
dnf -q --releasever=latest updateinfo list --security || true
dnf -y --releasever=latest upgrade --security
log "security updates applied"

set +e
dnf -q needs-restarting -r >/dev/null 2>&1
rc=$?
set -e
case "$rc" in
  0) log "no reboot needed" ;;
  1)
    if [ "$REBOOT" -eq 1 ]; then
      log "kernel or core libraries updated: rebooting in 1 minute"
      shutdown -r +1 "arc-os-patch: rebooting to load security updates"
    else
      log "reboot needed (skipped: --no-reboot)"
    fi
    ;;
  *) log "could not tell whether a reboot is needed (needs-restarting rc=$rc); not rebooting" ;;
esac
