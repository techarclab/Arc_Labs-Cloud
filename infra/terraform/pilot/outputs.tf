output "wix_ns_records" {
  description = "Add these in Wix → Domains → arclabs.in → DNS as NS records with host name 'arcloud' (replace the existing CNAME)."
  value       = aws_route53_zone.main.name_servers
}

output "server_public_ip" {
  value = aws_eip.server.public_ip
}

output "server_instance_id" {
  description = "Open a shell with: aws ssm start-session --target <id>"
  value       = aws_instance.server.id
}

output "api_url" {
  value = "https://${local.api_host}"
}

output "mqtt_endpoint" {
  value = "${local.mqtt_host}:8883"
}

output "console_url" {
  value = "https://${var.zone_name}"
}

output "console_bucket" {
  value = aws_s3_bucket.console.bucket
}

output "console_distribution_id" {
  value = aws_cloudfront_distribution.console.id
}

output "deploy_role_arn" {
  description = "Set as the GitHub environment 'pilot' variable AWS_DEPLOY_ROLE_ARN."
  value       = aws_iam_role.deploy.arn
}

output "db_endpoint" {
  value = aws_db_instance.main.address
}
