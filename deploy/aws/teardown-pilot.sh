#!/bin/bash
# Deletes the ARC Cloud AWS pilot (docs/deploy/aws-pilot.md, "Tear down"). Run it in AWS CloudShell, signed in
# to the pilot account (Mumbai region selected), never in the management account:
#   bash teardown-pilot.sh <pilot-account-id>            # lists what it would delete; changes nothing
#   bash teardown-pilot.sh <pilot-account-id> --delete   # deletes it, after you type the account ID again
#
# IRREVERSIBLE: the database is deleted WITHOUT a final snapshot, and the Terraform state (which holds the app
# secrets) is destroyed. Takes 20-40 minutes, mostly waiting for RDS and CloudFront. Safe to run again if it stops.
# Left for account closure, because they are free: VPC, subnets, route tables, security groups.
set -uo pipefail

ACCOUNT="${1:-}"
MODE="${2:-list}"
ENV=pilot
R=ap-south-1
U=us-east-1                       # CloudFront certificate, uptime SNS topic and alarms
ZONE=arcloud.arclabs.in
DB="arc-cloud-$ENV"
BUCKETS=("arc-cloud-$ENV-console-$ACCOUNT" "arc-cloud-tfstate-$ACCOUNT")
ROLES=("arc-cloud-$ENV-server" "arc-cloud-$ENV-github-deploy")
FAILED=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

log() { echo "[teardown] $*"; }
fail() { echo "[teardown] FAILED: $*" >&2; FAILED=$((FAILED + 1)); }
run() { "$@" > /dev/null 2> "$TMP/err" || { fail "$* -> $(tail -c 300 "$TMP/err")"; return 1; }; }
txt() { [ -n "$1" ]; }
q() { local out; out="$(aws "$@" --output text)" || return 1; [ "$out" = None ] && out=""; echo "$out"; }   # "None" = empty

[[ "$ACCOUNT" =~ ^[0-9]{12}$ ]] || { echo "usage: bash teardown-pilot.sh <pilot-account-id> [--delete]" >&2; exit 2; }
[ "$MODE" = list ] || [ "$MODE" = --delete ] || { echo "second argument must be --delete (or nothing to only list)" >&2; exit 2; }
CALLER="$(aws sts get-caller-identity --query Account --output text)" || exit 1
[ "$CALLER" = "$ACCOUNT" ] || { echo "Signed in to account $CALLER, not $ACCOUNT. Stopping." >&2; exit 1; }

# ---- what exists ----
DIST="$(q cloudfront list-distributions --query "DistributionList.Items[?Comment=='ARC Cloud $ENV console'].Id")"
INSTANCES="$(q ec2 describe-instances --region $R --filters Name=tag:Project,Values=arc-cloud Name=tag:Environment,Values=$ENV \
  Name=instance-state-name,Values=pending,running,stopping,stopped --query 'Reservations[].Instances[].InstanceId')"
EIPS="$(q ec2 describe-addresses --region $R --filters Name=tag:Project,Values=arc-cloud --query 'Addresses[].AllocationId')"
DB_STATUS="$(q rds describe-db-instances --region $R --db-instance-identifier "$DB" --query 'DBInstances[0].DBInstanceStatus' 2> /dev/null || true)"
SNAPSHOTS="$(q rds describe-db-snapshots --region $R --snapshot-type manual --query "DBSnapshots[?starts_with(DBSnapshotIdentifier,'arc-cloud')].DBSnapshotIdentifier")"
SECRETS="$(q secretsmanager list-secrets --region $R --query "SecretList[?starts_with(Name,'arc-cloud/')].ARN")"   # the RDS-managed one goes with the database
ALARMS_R="$(q cloudwatch describe-alarms --region $R --alarm-name-prefix "arc-cloud-$ENV-" --query 'MetricAlarms[].AlarmName')"
ALARMS_U="$(q cloudwatch describe-alarms --region $U --alarm-name-prefix "arc-cloud-$ENV-" --query 'MetricAlarms[].AlarmName')"
CHECKS="$(q route53 list-health-checks --query "HealthChecks[?HealthCheckConfig.FullyQualifiedDomainName=='api.$ZONE' || HealthCheckConfig.FullyQualifiedDomainName=='mqtt.$ZONE'].Id")"
TOPIC_R="$(q sns list-topics --region $R --query "Topics[?ends_with(TopicArn,':arc-cloud-$ENV-alerts')].TopicArn")"
TOPIC_U="$(q sns list-topics --region $U --query "Topics[?ends_with(TopicArn,':arc-cloud-$ENV-uptime')].TopicArn")"
LOGS="$(q logs describe-log-groups --region $R --log-group-name-prefix /arc-cloud/ --query 'logGroups[].logGroupName') $(q logs describe-log-groups --region $R --log-group-name-prefix "/aws/rds/instance/$DB/" --query 'logGroups[].logGroupName')"
CERTS="$(q acm list-certificates --region $U --query "CertificateSummaryList[?DomainName=='$ZONE'].CertificateArn")"
OAC="$(q cloudfront list-origin-access-controls --query "OriginAccessControlList.Items[?Name=='arc-cloud-$ENV-console'].Id")"
RHP="$(q cloudfront list-response-headers-policies --type custom --query "ResponseHeadersPolicyList.Items[?ResponseHeadersPolicy.ResponseHeadersPolicyConfig.Name=='arc-cloud-$ENV-console'].ResponseHeadersPolicy.Id")"
OIDC="arn:aws:iam::$ACCOUNT:oidc-provider/token.actions.githubusercontent.com"
BUDGET="arc-cloud-$ENV-monthly"
FOUND_BUCKETS=""
for b in "${BUCKETS[@]}"; do aws s3api head-bucket --bucket "$b" > /dev/null 2>&1 && FOUND_BUCKETS="$FOUND_BUCKETS $b"; done

echo
echo "ARC Cloud pilot in account $ACCOUNT. Found:"
echo "  CloudFront distribution : ${DIST:-none}   (+ origin access control ${OAC:-none}, headers policy ${RHP:-none})"
echo "  EC2 server              : ${INSTANCES:-none}   Elastic IPs: ${EIPS:-none}"
echo "  RDS database $DB  : ${DB_STATUS:-none}   (deleted WITHOUT final snapshot)   manual snapshots: ${SNAPSHOTS:-none}"
echo "  Secrets                 : $(wc -w <<< "$SECRETS")"
echo "  Alarms                  : $(wc -w <<< "$ALARMS_R") in $R, $(wc -w <<< "$ALARMS_U") in $U"
echo "  Route 53 health checks  : ${CHECKS:-none}"
echo "  SNS topics              : ${TOPIC_R:-none} ${TOPIC_U:-}"
echo "  Log groups              : $(wc -w <<< "$LOGS")"
echo "  S3 buckets (with every object version):${FOUND_BUCKETS:- none}"
echo "  ACM certificate ($U)    : ${CERTS:-none}"
echo "  IAM                     : roles ${ROLES[*]}, GitHub OIDC provider, budget $BUDGET"
echo

if [ "$MODE" = list ]; then
  log "nothing changed. To delete all of the above:  bash teardown-pilot.sh $ACCOUNT --delete"
  exit 0
fi
read -r -p "This deletes everything listed above and cannot be undone. Type the account ID again to continue: " answer
[ "$answer" = "$ACCOUNT" ] || { log "cancelled"; exit 1; }

# ---- 1. CloudFront: disabling takes 5-15 min, so start it first and delete at the end ----
if txt "$DIST"; then
  if [ "$(aws cloudfront get-distribution --id "$DIST" --query 'Distribution.DistributionConfig.Enabled' --output text)" = True ]; then
    etag="$(aws cloudfront get-distribution-config --id "$DIST" --query ETag --output text)"
    aws cloudfront get-distribution-config --id "$DIST" --query DistributionConfig --output json > "$TMP/cf.json"
    python3 -c 'import json,sys; p=sys.argv[1]; c=json.load(open(p)); c["Enabled"]=False; json.dump(c,open(p,"w"))' "$TMP/cf.json"
    run aws cloudfront update-distribution --id "$DIST" --if-match "$etag" --distribution-config "file://$TMP/cf.json" && log "CloudFront $DIST: disabling"
  fi
fi

# ---- 2. Server and its address ----
for id in $INSTANCES; do
  run aws ec2 modify-instance-attribute --region $R --instance-id "$id" --no-disable-api-termination
  run aws ec2 terminate-instances --region $R --instance-ids "$id" && log "EC2 $id: terminating"
done
if txt "$INSTANCES"; then
  # shellcheck disable=SC2086
  aws ec2 wait instance-terminated --region $R --instance-ids $INSTANCES && log "EC2 terminated (its disk is deleted with it)"
fi
for a in $EIPS; do run aws ec2 release-address --region $R --allocation-id "$a" && log "Elastic IP $a released"; done

# ---- 3. Database: deletion protection off (a stopped instance may first need starting), then delete ----
if txt "$DB_STATUS" && [ "$DB_STATUS" != deleting ]; then
  if ! aws rds modify-db-instance --region $R --db-instance-identifier "$DB" --no-deletion-protection --apply-immediately > /dev/null 2> "$TMP/err"; then
    if [ "$DB_STATUS" = stopped ]; then
      log "RDS is stopped and cannot be modified; starting it (5-10 min) only to remove deletion protection"
      run aws rds start-db-instance --region $R --db-instance-identifier "$DB"
      aws rds wait db-instance-available --region $R --db-instance-identifier "$DB"
      run aws rds modify-db-instance --region $R --db-instance-identifier "$DB" --no-deletion-protection --apply-immediately
    else
      fail "remove RDS deletion protection: $(tail -c 300 "$TMP/err")"
    fi
  fi
  for _ in $(seq 30); do   # wait until the change is applied (status leaves "modifying")
    read -r st dp <<< "$(aws rds describe-db-instances --region $R --db-instance-identifier "$DB" --query 'DBInstances[0].[DBInstanceStatus,DeletionProtection]' --output text)"
    [ "$dp" = False ] && [ "$st" != modifying ] && break
    sleep 10
  done
  run aws rds delete-db-instance --region $R --db-instance-identifier "$DB" --skip-final-snapshot --delete-automated-backups && log "RDS $DB: deleting (no final snapshot)"
fi
for s in $SNAPSHOTS; do run aws rds delete-db-snapshot --region $R --db-snapshot-identifier "$s" && log "snapshot $s deleted"; done

# ---- 4. Monitoring, secrets, logs ----
# shellcheck disable=SC2086
{ txt "$ALARMS_R" && run aws cloudwatch delete-alarms --region $R --alarm-names $ALARMS_R && log "alarms deleted in $R"; } || true
# shellcheck disable=SC2086
{ txt "$ALARMS_U" && run aws cloudwatch delete-alarms --region $U --alarm-names $ALARMS_U && log "alarms deleted in $U"; } || true
for c in $CHECKS; do run aws route53 delete-health-check --health-check-id "$c" && log "health check $c deleted"; done
for t in $TOPIC_R; do run aws sns delete-topic --region $R --topic-arn "$t" && log "SNS topic deleted ($R)"; done
for t in $TOPIC_U; do run aws sns delete-topic --region $U --topic-arn "$t" && log "SNS topic deleted ($U)"; done
aws budgets delete-budget --account-id "$ACCOUNT" --budget-name "$BUDGET" > /dev/null 2>&1 && log "budget deleted"
for s in $SECRETS; do run aws secretsmanager delete-secret --region $R --secret-id "$s" --force-delete-without-recovery && log "secret deleted: ${s##*:secret:}"; done
for g in $LOGS; do run aws logs delete-log-group --region $R --log-group-name "$g" && log "log group $g deleted"; done

# ---- 5. Buckets: every object version and delete marker, then the bucket ----
empty_bucket() {
  local b="$1" batch n
  while :; do
    batch="$(aws s3api list-object-versions --bucket "$b" --max-items 500 --output json \
      --query '{Objects: [Versions, DeleteMarkers][][].{Key: Key, VersionId: VersionId}, Quiet: `true`}')" || return 1
    n="$(python3 -c 'import json,sys; print(len(json.load(sys.stdin)["Objects"] or []))' <<< "$batch")"
    [ "$n" -eq 0 ] && return 0
    aws s3api delete-objects --bucket "$b" --delete "$batch" > /dev/null || return 1
  done
}
for b in $FOUND_BUCKETS; do
  if empty_bucket "$b"; then run aws s3api delete-bucket --bucket "$b" && log "bucket $b deleted"; else fail "empty bucket $b"; fi
done

# ---- 6. IAM (free, but the GitHub role would otherwise stay assumable until the account closes) ----
for role in "${ROLES[@]}"; do
  aws iam get-role --role-name "$role" > /dev/null 2>&1 || continue
  for p in $(aws iam list-attached-role-policies --role-name "$role" --query 'AttachedPolicies[].PolicyArn' --output text); do
    run aws iam detach-role-policy --role-name "$role" --policy-arn "$p"
  done
  for p in $(aws iam list-role-policies --role-name "$role" --query 'PolicyNames' --output text); do
    run aws iam delete-role-policy --role-name "$role" --policy-name "$p"
  done
  for ip in $(aws iam list-instance-profiles-for-role --role-name "$role" --query 'InstanceProfiles[].InstanceProfileName' --output text); do
    run aws iam remove-role-from-instance-profile --instance-profile-name "$ip" --role-name "$role"
    run aws iam delete-instance-profile --instance-profile-name "$ip"
  done
  run aws iam delete-role --role-name "$role" && log "IAM role $role deleted"
done
aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$OIDC" > /dev/null 2>&1 &&
  run aws iam delete-open-id-connect-provider --open-id-connect-provider-arn "$OIDC" && log "GitHub OIDC provider deleted"

# ---- 7. Wait for RDS, then its subnet and parameter groups ----
if txt "$DB_STATUS"; then
  log "waiting for RDS deletion (5-15 min)"
  aws rds wait db-instance-deleted --region $R --db-instance-identifier "$DB" || fail "RDS deletion wait timed out; run the script again later"
  for ab in $(aws rds describe-db-instance-automated-backups --region $R --db-instance-identifier "$DB" --query 'DBInstanceAutomatedBackups[].DBInstanceAutomatedBackupsArn' --output text 2> /dev/null); do
    run aws rds delete-db-instance-automated-backup --region $R --db-instance-automated-backups-arn "$ab"
  done
fi
aws rds describe-db-subnet-groups --region $R --db-subnet-group-name "$DB" > /dev/null 2>&1 &&
  run aws rds delete-db-subnet-group --region $R --db-subnet-group-name "$DB" && log "DB subnet group deleted"
aws rds describe-db-parameter-groups --region $R --db-parameter-group-name "$DB-pg16" > /dev/null 2>&1 &&
  run aws rds delete-db-parameter-group --region $R --db-parameter-group-name "$DB-pg16" && log "DB parameter group deleted"

# ---- 8. CloudFront: wait until disabled, then delete it, its access control, headers policy and certificate ----
if txt "$DIST"; then
  log "waiting for CloudFront to finish disabling (up to ~15 min)"
  if aws cloudfront wait distribution-deployed --id "$DIST"; then
    etag="$(aws cloudfront get-distribution --id "$DIST" --query ETag --output text)"
    run aws cloudfront delete-distribution --id "$DIST" --if-match "$etag" && log "CloudFront $DIST deleted"
  else
    fail "CloudFront still deploying; run the script again in 15 minutes"
  fi
fi
for o in $OAC; do
  etag="$(aws cloudfront get-origin-access-control --id "$o" --query ETag --output text 2> /dev/null)" &&
    run aws cloudfront delete-origin-access-control --id "$o" --if-match "$etag" && log "origin access control deleted"
done
for p in $RHP; do
  etag="$(aws cloudfront get-response-headers-policy --id "$p" --query ETag --output text 2> /dev/null)" &&
    run aws cloudfront delete-response-headers-policy --id "$p" --if-match "$etag" && log "response headers policy deleted"
done
for c in $CERTS; do run aws acm delete-certificate --region $U --certificate-arn "$c" && log "ACM certificate deleted"; done

# ---- 9. Anything billable left, in every region ----
log "checking every region for anything still billable"
left=0
for reg in $(aws ec2 describe-regions --query 'Regions[].RegionName' --output text); do
  n_i="$(aws ec2 describe-instances --region "$reg" --filters Name=instance-state-name,Values=pending,running,stopping,stopped --query 'length(Reservations[].Instances[])' --output text 2> /dev/null || echo 0)"
  n_v="$(aws ec2 describe-volumes --region "$reg" --query 'length(Volumes)' --output text 2> /dev/null || echo 0)"
  n_s="$(aws ec2 describe-snapshots --region "$reg" --owner-ids self --query 'length(Snapshots)' --output text 2> /dev/null || echo 0)"
  n_a="$(aws ec2 describe-addresses --region "$reg" --query 'length(Addresses)' --output text 2> /dev/null || echo 0)"
  n_n="$(aws ec2 describe-nat-gateways --region "$reg" --filter Name=state,Values=pending,available --query 'length(NatGateways)' --output text 2> /dev/null || echo 0)"
  n_d="$(aws rds describe-db-instances --region "$reg" --query 'length(DBInstances)' --output text 2> /dev/null || echo 0)"
  n_ds="$(aws rds describe-db-snapshots --region "$reg" --snapshot-type manual --query 'length(DBSnapshots)' --output text 2> /dev/null || echo 0)"
  n_l="$(aws elbv2 describe-load-balancers --region "$reg" --query 'length(LoadBalancers)' --output text 2> /dev/null || echo 0)"
  n_k="$(aws secretsmanager list-secrets --region "$reg" --query 'length(SecretList)' --output text 2> /dev/null || echo 0)"
  sum=$((n_i + n_v + n_s + n_a + n_n + n_d + n_ds + n_l + n_k))
  if [ "$sum" -gt 0 ]; then
    left=$((left + sum))
    echo "  $reg: instances=$n_i volumes=$n_v ebs-snapshots=$n_s elastic-ips=$n_a nat=$n_n rds=$n_d rds-snapshots=$n_ds load-balancers=$n_l secrets=$n_k"
  fi
done
echo "  S3 buckets left: $(aws s3api list-buckets --query 'length(Buckets)' --output text)   CloudFront distributions left: $(aws cloudfront list-distributions --query 'length(DistributionList.Items || `[]`)' --output text)   health checks left: $(aws route53 list-health-checks --query 'length(HealthChecks)' --output text)"

echo
if [ "$FAILED" -eq 0 ] && [ "$left" -eq 0 ]; then
  log "done: nothing billable is left in this account. Next: close the account (docs/deploy/aws-pilot.md, \"Tear down\")."
else
  log "finished with $FAILED failed step(s) and $left billable resource(s) still listed above. Run the script again;"
  log "if the same step keeps failing, send the output before closing the account."
  exit 1
fi
