#!/usr/bin/env bash
# Import a Railway PostgreSQL logical dump into the AWS RDS database.
# Create the dump yourself and keep its credentials out of chat; this script accepts only a file.
#
#   bash tools/aws-copy-railway-data.sh backups/railway.dump
#
# The AWS database is snapshotted before replacement. The AWS API and worker pause during import;
# Railway and its running services are never changed. The temporary encrypted S3 copy is deleted.
set -euo pipefail
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL="*" AWS_PAGER=""
cd "$(dirname "$0")/.." || exit 1

PROFILE="${ARC_AWS_PROFILE:-arc-cloud-migration}"
REGION="${ARC_AWS_REGION:-ap-southeast-1}"
STACK="${ARC_AWS_STACK:-arc-cloud-backend}"
DUMP_INPUT="${1:-backups/railway.dump}"
DUMP=""
WORK=""
LOGS="/arc-cloud/data-import"
ROLE="arc-cloud-backup-import-task"
POLICY="TemporaryRailwayDumpRead"
TASK=""
TASKDEF=""
BUCKET=""
API_WAS=""
WORKER_WAS=""
PAUSED=0
ROLE_CREATED=0

say()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
ok()   { printf '   \033[32mOK\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31mStopped: %s\033[0m\n' "$*"; exit 1; }
A() { aws --profile "$PROFILE" --region "$REGION" "$@"; }
Q() { A "$@" 2>/dev/null | tr -d '\r'; }
res() { Q cloudformation describe-stack-resource --stack-name "$STACK" --logical-resource-id "$1" --query StackResourceDetail.PhysicalResourceId --output text; }
param() { Q cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Parameters[?ParameterKey=='$1'].ParameterValue | [0]" --output text; }

restore_services() {
  [ -n "$API_WAS" ] && A ecs update-service --cluster "$CLUSTER" --service api --desired-count "$API_WAS" >/dev/null 2>&1 || true
  [ -n "$WORKER_WAS" ] && A ecs update-service --cluster "$CLUSTER" --service worker --desired-count "$WORKER_WAS" >/dev/null 2>&1 || true
}

cleanup() {
  result=$?
  trap - EXIT INT TERM
  if [ -n "$TASK" ]; then
    task_state="$(Q ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK" --query 'tasks[0].lastStatus' --output text || true)"
    if [ -n "$task_state" ] && [ "$task_state" != STOPPED ] && [ "$task_state" != None ]; then
      A ecs stop-task --cluster "$CLUSTER" --task "$TASK" --reason 'Import script is exiting' >/dev/null 2>&1 || true
      A ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK" >/dev/null 2>&1 || true
    fi
  fi
  if [ "$PAUSED" = 1 ]; then
    say "Restoring the AWS API and worker service counts"
    restore_services
  fi
  if [ -n "$TASKDEF" ]; then A ecs deregister-task-definition --task-definition "$TASKDEF" >/dev/null 2>&1 || true; fi
  A iam delete-role-policy --role-name "$ROLE" --policy-name "$POLICY" >/dev/null 2>&1 || true
  if [ "$ROLE_CREATED" = 1 ]; then A iam delete-role --role-name "$ROLE" >/dev/null 2>&1 || true; fi
  if [ -n "$BUCKET" ]; then
    A s3 rm "s3://$BUCKET/railway.dump" --only-show-errors >/dev/null 2>&1 || true
    A s3api delete-bucket --bucket "$BUCKET" >/dev/null 2>&1 || true
  fi
  [ -n "$WORK" ] && rm -rf "$WORK"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

command -v aws >/dev/null || die "the AWS CLI isn't installed."
command -v node >/dev/null || die "Node.js is not installed."
[ -f "$DUMP_INPUT" ] || die "backup file not found: $DUMP_INPUT."
[ -s "$DUMP_INPUT" ] || die "backup file is empty: $DUMP_INPUT."
if command -v cygpath >/dev/null; then
  DUMP="$(cygpath -aw "$DUMP_INPUT")"
else
  DUMP="$(cd "$(dirname "$DUMP_INPUT")" && pwd)/$(basename "$DUMP_INPUT")"
fi
umask 077
mkdir -p .aws-copy
WORK="$(mktemp -d .aws-copy/aws-import.XXXXXX)"

say "1/6  AWS sign-in and stack"
ACCOUNT="$(Q sts get-caller-identity --query Account --output text)"
[ -n "$ACCOUNT" ] && [ "$ACCOUNT" != None ] || die "AWS sign-in expired. Run: aws sso login --profile $PROFILE"
STATUS="$(Q cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].StackStatus' --output text)"
case "$STATUS" in CREATE_COMPLETE|UPDATE_COMPLETE|UPDATE_ROLLBACK_COMPLETE) ;; *) die "stack $STACK is '$STATUS'; it must be finished first." ;; esac
[ "$(param ProtectDatabase)" != true ] || die "RDS deletion protection is enabled; review the import plan before proceeding."
CLUSTER="$(res EcsCluster)"
API_SG="$(res ApiSecurityGroup)"
EXEC_ROLE="$(res TaskExecutionRole)"
DB_SECRET="$(res DatabaseUrlSecret)"
SUBNET_A="$(param PublicSubnetA)"
SUBNET_B="$(param PublicSubnetB)"
DB_INSTANCE="$(res Database)"
for v in CLUSTER API_SG EXEC_ROLE DB_SECRET SUBNET_A SUBNET_B DB_INSTANCE; do
  [ -n "${!v}" ] && [ "${!v}" != None ] || die "couldn't read $v from stack $STACK."
done
ok "account $ACCOUNT, stack $STACK ($STATUS), cluster $CLUSTER"

desired() { Q ecs describe-services --cluster "$CLUSTER" --services "$1" --query 'services[0].desiredCount' --output text; }
API_WAS="$(desired api)"
WORKER_WAS="$(desired worker)"
[[ "$API_WAS" =~ ^[0-9]+$ && "$WORKER_WAS" =~ ^[0-9]+$ ]] || die "couldn't determine the current API and worker service counts."
ok "AWS API desired count $API_WAS; worker desired count $WORKER_WAS"

cat <<INFO

This will replace the AWS database contents with the dump at:
  $DUMP

Railway is not changed. This script creates an RDS snapshot, pauses the AWS API and worker during
the import, restores their previous counts, and deletes its temporary encrypted S3 copy at exit.
INFO
read -r -p "Continue with the AWS database import? [y/N] " answer
[[ "$answer" =~ ^[Yy] ]] || die "nothing changed."

say "2/6  Encrypted temporary upload and RDS safety snapshot"
stamp="$(date -u +%Y%m%d%H%M%S)-$RANDOM"
BUCKET="arc-cloud-db-import-${ACCOUNT}-${stamp}"
SNAPSHOT="arc-cloud-pre-import-${stamp}"
A s3api create-bucket --bucket "$BUCKET" --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null || die "couldn't create the temporary transfer bucket."
A s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true >/dev/null || die "couldn't block public access to the temporary bucket."
A s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}' >/dev/null || die "couldn't enable bucket encryption."
A s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --lifecycle-configuration '{"Rules":[{"ID":"expire-transfer-dump","Status":"Enabled","Filter":{"Prefix":""},"Expiration":{"Days":1}}]}' >/dev/null || die "couldn't set automatic cleanup for the temporary dump."
A s3 cp "$DUMP" "s3://$BUCKET/railway.dump" --sse AES256 --only-show-errors || die "couldn't upload the dump to the encrypted temporary bucket."
A rds create-db-snapshot --db-instance-identifier "$DB_INSTANCE" --db-snapshot-identifier "$SNAPSHOT" >/dev/null || die "couldn't create the AWS RDS safety snapshot."
A rds wait db-snapshot-available --db-snapshot-identifier "$SNAPSHOT" || die "the AWS safety snapshot did not complete."
ok "safety snapshot $SNAPSHOT is available; transfer bucket is private and encrypted"

say "3/6  One-time import task permissions"
if ! A iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  cat > "$WORK/trust.json" <<'TRUST'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}
TRUST
  A iam create-role --role-name "$ROLE" --assume-role-policy-document "file://$WORK/trust.json" >/dev/null || die "couldn't create the temporary import task role."
  ROLE_CREATED=1
  sleep 12
fi
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({Version:"2012-10-17",Statement:[{Effect:"Allow",Action:"s3:GetObject",Resource:`arn:aws:s3:::${process.argv[2]}/railway.dump`}]}))' "$WORK/policy.json" "$BUCKET"
A iam put-role-policy --role-name "$ROLE" --policy-name "$POLICY" --policy-document "file://$WORK/policy.json" >/dev/null || die "couldn't grant the import task read access to the temporary dump."
A logs create-log-group --log-group-name "$LOGS" >/dev/null 2>&1 || true
A logs put-retention-policy --log-group-name "$LOGS" --retention-in-days 14 >/dev/null 2>&1 || true
ROLE_ARN="arn:aws:iam::$ACCOUNT:role/$ROLE"
node -e '
const fs=require("fs"); const [out,script,taskRole,execRole,bucket,region,logs,family,secret]=process.argv.slice(1);
fs.writeFileSync(out, JSON.stringify({family,networkMode:"awsvpc",requiresCompatibilities:["FARGATE"],cpu:"1024",memory:"2048",ephemeralStorage:{sizeInGiB:50},taskRoleArn:taskRole,executionRoleArn:execRole,
  containerDefinitions:[{name:"import",image:"public.ecr.aws/docker/library/postgres:18-alpine",essential:true,user:"0",entryPoint:["sh","-c"],command:[fs.readFileSync(script,"utf8")],
    environment:[{name:"BACKUP_BUCKET",value:bucket},{name:"AWS_DEFAULT_REGION",value:region}],secrets:[{name:"AWS_DATABASE_URL",valueFrom:secret}],
    logConfiguration:{logDriver:"awslogs",options:{"awslogs-group":logs,"awslogs-region":region,"awslogs-stream-prefix":"import"}}}]}));
' "$WORK/taskdef.json" infra/aws/copy-railway-db.sh "$ROLE_ARN" "$EXEC_ROLE" "$BUCKET" "$REGION" "$LOGS" arc-cloud-data-import "$DB_SECRET"
TASKDEF="$(Q ecs register-task-definition --cli-input-json "file://$WORK/taskdef.json" --query taskDefinition.taskDefinitionArn --output text)"
[ -n "$TASKDEF" ] && [ "$TASKDEF" != None ] || die "couldn't register the one-time import task."
ok "one-time import task is ready; its role can read only the temporary dump object"

say "4/6  Pausing only the AWS API and worker"
PAUSED=1
A ecs update-service --cluster "$CLUSTER" --service api --desired-count 0 >/dev/null || die "couldn't pause the AWS API."
A ecs update-service --cluster "$CLUSTER" --service worker --desired-count 0 >/dev/null || die "couldn't pause the AWS worker."
A ecs wait services-stable --cluster "$CLUSTER" --services api worker || die "the AWS API and worker did not stop cleanly."
ok "AWS API and worker paused; Railway remains live"

say "5/6  Importing the dump inside the AWS VPC"
TASK="$(Q ecs run-task --cluster "$CLUSTER" --task-definition "$TASKDEF" --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNET_A,$SUBNET_B],securityGroups=[$API_SG],assignPublicIp=ENABLED}" \
  --query 'tasks[0].taskArn' --output text)"
[ -n "$TASK" ] && [ "$TASK" != None ] || die "couldn't start the one-time import task."
A ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK" || die "the import task did not finish before the AWS CLI waiter timed out."
TASK_ID="${TASK##*/}"
CODE="$(Q ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK" --query 'tasks[0].containers[0].exitCode' --output text)"
LOG="$(Q logs get-log-events --log-group-name "$LOGS" --log-stream-name "import/import/$TASK_ID" --start-from-head --query 'events[*].message' --output json \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).join("\n"))}catch{}})')"
printf '%s\n' "$LOG" | grep -v '^$' | sed 's/^/   | /'
if [ "$CODE" != 0 ] || ! grep -q IMPORT-OK <<<"$LOG"; then
  die "the import failed (exit ${CODE:-unknown}). The Railway dump is unchanged; AWS has the safety snapshot $SNAPSHOT."
fi
ok "AWS database import completed"

say "6/6  Complete"
printf '   RDS safety snapshot: %s\n' "$SNAPSHOT"
printf '   The API and worker return to their previous desired counts when this script exits.\n'
printf '   Verify AWS sign-in, data, and device ingestion before switching Vercel or devices.\n'
