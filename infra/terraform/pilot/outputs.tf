output "wix_records" {
  description = "Records to add in Wix → Domains → arclabs.in → Manage DNS records (host names WITHOUT .arclabs.in)."
  value = {
    step_1_before_full_apply = concat(
      [for o in aws_acm_certificate.console.domain_validation_options : {
        section = "CNAME", host = trimsuffix(trimsuffix(o.resource_record_name, "."), ".arclabs.in"), value = trimsuffix(o.resource_record_value, ".")
      }],
      [
        { section = "A (Host)", host = trimsuffix(local.api_host, ".arclabs.in"), value = aws_eip.server.public_ip },
        { section = "A (Host)", host = trimsuffix(local.mqtt_host, ".arclabs.in"), value = aws_eip.server.public_ip },
      ]
    )
    step_2_after_full_apply = [
      { section = "CNAME (replace the Vercel value)", host = trimsuffix(var.zone_name, ".arclabs.in"), value = try(aws_cloudfront_distribution.console.domain_name, "(created by the full apply)") },
    ]
  }
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
