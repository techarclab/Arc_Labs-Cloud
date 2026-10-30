# Application uptime alerts. The EC2/RDS alarms (compute.tf, monitoring.tf) only see the machines; these see the
# service as devices and users do.
#
# Outside-in (Route 53 health checkers in several AWS regions, independent of the server):
#   api   HTTPS GET https://api.<zone>/health/deep: 200 only when the database answers AND the API can publish
#         to the broker. Catches: server/Caddy/API down, database down, the API's broker connection lost
#         (switches, commands and OTA silently stopped: the 2026-10-28 incident), and broken DNS in Wix.
#   mqtt  TCP connect to mqtt.<zone>:8883. Catches: EMQX listener down or port blocked.
# Route 53 publishes health-check metrics only in us-east-1, so those alarms and their SNS topic live there.
#
# Inside (deploy/aws/arc-monitor.sh, every 5 min, namespace ARC/Cloud):
#   certificate days left for :443 and :8883, and ingestion-worker readiness.
#
# Cost: 2 health checks + 1 optional feature (HTTPS) on the api check; a few alarms and custom metrics, mostly
# inside the CloudWatch free tier. See docs/deploy/aws-pilot.md for the figures.

locals {
  uptime_failure_periods = 3 # minutes of failure before an alert; keeps short deploy restarts from paging
}

resource "aws_sns_topic" "alerts_us_east_1" {
  provider = aws.us_east_1
  name     = "arc-cloud-${var.environment}-uptime"
}

resource "aws_sns_topic_subscription" "alerts_us_east_1_email" {
  provider  = aws.us_east_1
  topic_arn = aws_sns_topic.alerts_us_east_1.arn
  protocol  = "email"
  endpoint  = var.alert_email # a second confirmation email (this topic is in us-east-1); click it or nothing is delivered
}

resource "aws_route53_health_check" "api" {
  fqdn              = local.api_host # resolved through public DNS (Wix) on every check, so DNS breakage is caught
  port              = 443
  type              = "HTTPS"
  resource_path     = "/health/deep"
  enable_sni        = true
  request_interval  = 30
  failure_threshold = 3
  tags              = { Name = "arc-cloud-${var.environment}-api" }
}

resource "aws_route53_health_check" "mqtt" {
  fqdn              = local.mqtt_host
  port              = 8883
  type              = "TCP"
  request_interval  = 30
  failure_threshold = 3
  tags              = { Name = "arc-cloud-${var.environment}-mqtt" }
}

resource "aws_cloudwatch_metric_alarm" "uptime" {
  for_each = {
    api  = { id = aws_route53_health_check.api.id, what = "API ${local.api_host} (/health/deep: database + broker connection)" }
    mqtt = { id = aws_route53_health_check.mqtt.id, what = "MQTT broker ${local.mqtt_host}:8883" }
  }
  provider            = aws.us_east_1
  alarm_name          = "arc-cloud-${var.environment}-${each.key}-down"
  alarm_description   = "${each.value.what} is failing Route 53 health checks."
  namespace           = "AWS/Route53"
  metric_name         = "HealthCheckStatus"
  dimensions          = { HealthCheckId = each.value.id }
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = local.uptime_failure_periods
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alerts_us_east_1.arn]
  ok_actions          = [aws_sns_topic.alerts_us_east_1.arn]
}

resource "aws_cloudwatch_metric_alarm" "cert_expiry" {
  for_each            = toset([local.api_host, local.mqtt_host])
  alarm_name          = "arc-cloud-${var.environment}-cert-expiry-${split(".", each.key)[0]}"
  alarm_description   = "TLS certificate served for ${each.key} expires in under 14 days (or could not be read: -1). Caddy renews at ~30 days; for mqtt check arc-cert-sync."
  namespace           = "ARC/Cloud"
  metric_name         = "CertDaysLeft"
  dimensions          = { Host = each.key }
  statistic           = "Minimum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 14
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "notBreaching" # a silent monitor is caught by the worker alarm below
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "worker_ready" {
  alarm_name          = "arc-cloud-${var.environment}-worker-not-ready"
  alarm_description   = "The ingestion worker is not ready (database or broker), or arc-monitor stopped reporting. Readings, alerts, webhooks and rollouts stop while this lasts."
  namespace           = "ARC/Cloud"
  metric_name         = "WorkerReady"
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}
