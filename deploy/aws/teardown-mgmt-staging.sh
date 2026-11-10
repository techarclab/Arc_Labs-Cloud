#!/bin/bash
# Removes the leftovers of the first ARC Cloud staging stack (2026-10-11, AWS IoT Core design) from the
# management account. Run in AWS CloudShell, signed in to the MANAGEMENT account, Mumbai region:
#   bash teardown-mgmt-staging.sh <management-account-id>            # lists what it would delete
#   bash teardown-mgmt-staging.sh <management-account-id> --delete   # deletes it, after confirmation
#
# Touches only names that start with arc-staging / arc_staging, the role claude-arc-cloud-deployer, and the IoT
# policy "arc-device" if nothing is attached to it. Everything else in that account (ArcHome: IoT things and
# policies, Lambda, DynamoDB, Lightsail, S3, IAM user archome-backend; IAM Identity Center and its KMS key) is
# never touched.
set -uo pipefail

ACCOUNT="${1:-}"
MODE="${2:-list}"
R=ap-south-1
FAILED=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

log() { echo "[staging-cleanup] $*"; }
fail() { echo "[staging-cleanup] FAILED: $*" >&2; FAILED=$((FAILED + 1)); }
run() { "$@" > /dev/null 2> "$TMP/err" || { fail "$* -> $(tail -c 300 "$TMP/err")"; return 1; }; }
q() { local out; out="$(aws "$@" --output text)" || return 1; [ "$out" = None ] && out=""; echo "$out"; }

[[ "$ACCOUNT" =~ ^[0-9]{12}$ ]] || { echo "usage: bash teardown-mgmt-staging.sh <management-account-id> [--delete]" >&2; exit 2; }
[ "$MODE" = list ] || [ "$MODE" = --delete ] || { echo "second argument must be --delete (or nothing to only list)" >&2; exit 2; }
CALLER="$(aws sts get-caller-identity --query Account --output text)" || exit 1
[ "$CALLER" = "$ACCOUNT" ] || { echo "Signed in to account $CALLER, not $ACCOUNT. Stopping." >&2; exit 1; }

RULES="$(q iot list-topic-rules --region $R --query "rules[?starts_with(ruleName,'arc_staging_')].ruleName")"
QUEUES="$(q sqs list-queues --region $R --queue-name-prefix arc-staging- --query 'QueueUrls')"
ALARMS="$(q cloudwatch describe-alarms --region $R --query "MetricAlarms[?contains(AlarmName,'arc-staging') || contains(AlarmName,'arc_staging')].AlarmName")"
ROLES="$(q iam list-roles --query "Roles[?starts_with(RoleName,'arc-staging-') || RoleName=='claude-arc-cloud-deployer'].RoleName")"
POLICIES="$(q iam list-policies --scope Local --query "Policies[?starts_with(PolicyName,'arc-staging-')].Arn")"
IOT_POLICY=""
if aws iot get-policy --region $R --policy-name arc-device > /dev/null 2>&1; then
  targets="$(q iot list-targets-for-policy --region $R --policy-name arc-device --query 'targets')"
  if [ -z "$targets" ]; then IOT_POLICY=arc-device; else log "IoT policy arc-device is attached to something; leaving it"; fi
fi

echo
echo "Old ARC Cloud staging in account $ACCOUNT ($R). Found:"
echo "  IoT topic rules : ${RULES:-none}"
echo "  SQS queues      : ${QUEUES:-none}"
echo "  Alarms          : ${ALARMS:-none}"
echo "  IAM roles       : ${ROLES:-none}"
echo "  IAM policies    : ${POLICIES:-none}"
echo "  IoT policy      : ${IOT_POLICY:-none (or still attached)}"
echo "  (IoT thing type \"arc-device\", if any, is free and is left alone.)"
echo

if [ "$MODE" = list ]; then
  log "nothing changed. To delete the above:  bash teardown-mgmt-staging.sh $ACCOUNT --delete"
  exit 0
fi
read -r -p "Delete only the items listed above? Type the account ID again to continue: " answer
[ "$answer" = "$ACCOUNT" ] || { log "cancelled"; exit 1; }

for r in $RULES; do run aws iot delete-topic-rule --region $R --rule-name "$r" && log "IoT rule $r deleted"; done
for u in $QUEUES; do run aws sqs delete-queue --region $R --queue-url "$u" && log "queue ${u##*/} deleted"; done
# shellcheck disable=SC2086
{ [ -n "$ALARMS" ] && run aws cloudwatch delete-alarms --region $R --alarm-names $ALARMS && log "alarms deleted"; } || true

for role in $ROLES; do
  for p in $(q iam list-attached-role-policies --role-name "$role" --query 'AttachedPolicies[].PolicyArn'); do
    run aws iam detach-role-policy --role-name "$role" --policy-arn "$p"
  done
  for p in $(q iam list-role-policies --role-name "$role" --query 'PolicyNames'); do
    run aws iam delete-role-policy --role-name "$role" --policy-name "$p"
  done
  for ip in $(q iam list-instance-profiles-for-role --role-name "$role" --query 'InstanceProfiles[].InstanceProfileName'); do
    run aws iam remove-role-from-instance-profile --instance-profile-name "$ip" --role-name "$role"
  done
  run aws iam delete-role --role-name "$role" && log "role $role deleted"
done

for arn in $POLICIES; do
  for r in $(q iam list-entities-for-policy --policy-arn "$arn" --query 'PolicyRoles[].RoleName'); do run aws iam detach-role-policy --role-name "$r" --policy-arn "$arn"; done
  for u in $(q iam list-entities-for-policy --policy-arn "$arn" --query 'PolicyUsers[].UserName'); do run aws iam detach-user-policy --user-name "$u" --policy-arn "$arn"; done
  for g in $(q iam list-entities-for-policy --policy-arn "$arn" --query 'PolicyGroups[].GroupName'); do run aws iam detach-group-policy --group-name "$g" --policy-arn "$arn"; done
  for v in $(q iam list-policy-versions --policy-arn "$arn" --query 'Versions[?!IsDefaultVersion].VersionId'); do run aws iam delete-policy-version --policy-arn "$arn" --version-id "$v"; done
  run aws iam delete-policy --policy-arn "$arn" && log "policy ${arn##*/} deleted"
done

if [ -n "$IOT_POLICY" ]; then
  for v in $(q iot list-policy-versions --region $R --policy-name "$IOT_POLICY" --query 'policyVersions[?!isDefaultVersion].versionId'); do
    run aws iot delete-policy-version --region $R --policy-name "$IOT_POLICY" --policy-version-id "$v"
  done
  run aws iot delete-policy --region $R --policy-name "$IOT_POLICY" && log "IoT policy $IOT_POLICY deleted"
fi

echo
if [ "$FAILED" -eq 0 ]; then log "done. ArcHome and everything else in this account were not touched."; else log "$FAILED step(s) failed (above). Run again, or send the output."; exit 1; fi
