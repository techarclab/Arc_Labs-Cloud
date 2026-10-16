# ARC Cloud AWS backend

This stack runs ARC Cloud on AWS. The Railway deployment remains available as a rollback until
devices have been moved and verified. The GitHub Actions workflow is unchanged.

## Services

- API and ingestion worker run as separate ECS/Fargate services from the existing backend image.
- EMQX runs as an ECS/Fargate service from the existing EMQX image.
- PostgreSQL runs on RDS in private subnets. The app applies its normal SQL migrations at API startup.
- API Gateway HTTP API provides the public HTTPS endpoint and reaches the API through a private
  VPC link and an internal NLB listener on port 80. This NLB is placed in the isolated private
  subnets and accepts traffic only from the VPC link.
- MQTT TCP 8883 is exposed through a separate internet-facing Network Load Balancer. Port 1883 is
  restricted to the API and worker security groups; the EMQX dashboard is not exposed.
- Runtime secrets are generated in Secrets Manager. Logs are retained in CloudWatch for 14 days.

The stack is in `backend-stack.yaml`. It uses the existing default VPC for the two public task
subnets and creates two isolated subnets for RDS, the private API NLB, and the API Gateway VPC
link. Fargate tasks receive public IPs for outbound image pulls. The API accepts traffic only from
the private API NLB; the broker accepts MQTT traffic only from the public MQTT NLB and internal
traffic from ARC Cloud services; the worker has no inbound access.

## Current rollout order

1. Build and push immutable images to ECR.
2. Create the AWS services in parallel with Railway. The API starts; the worker and MQTT broker
   start at desired count zero until the broker TLS certificate is installed.
3. Generate a server certificate for the exact `MqttHost` stack output, save the CA certificate for
   device firmware, and write the base64 CA/server certificate/key to the `MqttTlsSecretArn` output.
4. Start the EMQX service, then start the worker.
5. Export the Railway PostgreSQL database, restore it to AWS, then verify sign-in and API health.
   The database import and AWS API verification are complete.
6. Set Vercel's `VITE_API_URL` to the `HttpApiUrl` stack output and redeploy the console. The
   production console now uses the AWS API.
7. Move physical devices to AWS. HTTP sketches use the `HttpApiUrl`; MQTT devices use the `MqttHost`
   and port `8883` with `infra/certs/aws/ca.crt`. The provided ESP32 examples are updated with the
   current endpoints and the AWS MQTT CA. Copy `firmware/esp32-arduino/arc_device/config.example.h`
   to your private `config.h`, fill in each device's existing ID/password and topic values, then
   compile and upload the firmware. Verify telemetry, controls, and commands for every device.
8. Keep Railway available until device verification succeeds. Then stop Railway services after
   confirming no devices or users depend on them.

Never send or commit AWS passwords, access keys, DB URLs, MQTT private keys, or device secrets.
Use the existing `arc-cloud-migration` AWS CLI SSO profile. Do not publish the CA private key; only
the CA certificate belongs in the device firmware.

## Stack commands

```powershell
aws sts get-caller-identity --profile arc-cloud-migration
aws cloudformation describe-stacks --stack-name arc-cloud-backend --region ap-southeast-1 --profile arc-cloud-migration
aws ecs describe-services --cluster arc-cloud --services api worker emqx --region ap-southeast-1 --profile arc-cloud-migration
```

Use the stack outputs rather than copying endpoint IDs by hand. The stack is currently configured
for the Vercel origin `https://arc-labs-cloud.vercel.app` and the Google OAuth Web client ID already
provided for ARC Cloud.

## Importing the Railway data (rollout step 5)

Create a PostgreSQL logical dump on your computer using Railway's [backup and restore guide](https://docs.railway.com/guides/postgres-backups-restores). Prefer the Railway CLI's SSH tunnel if you do not already have public database access. Save a custom-format dump as `backups/railway.dump`; do not paste a database URL, password, or dump contents into chat.

From Git Bash, after `aws sso login --profile arc-cloud-migration`:

```bash
cd /c/arc-cloud
bash tools/aws-copy-railway-data.sh backups/railway.dump
```

The script asks before replacing the AWS `arc_cloud` database, creates an RDS safety snapshot,
uploads the dump to a temporary private, encrypted S3 bucket, pauses the AWS `api` and `worker`,
then restores the file with a one-off Fargate task inside the AWS VPC. It removes the temporary S3
copy and restores the services' previous desired counts. Railway is never modified.

The Railway dump was imported to AWS and verified. Device keys and passwords carry over; sign-in
sessions do not (the AWS JWT secret is new), so people sign in again after the switch.
