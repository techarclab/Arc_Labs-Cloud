# One t4g.medium runs Caddy (TLS), EMQX, the API and the ingestion worker via Docker Compose
# (deploy/aws/docker-compose.yml). No SSH: administer with SSM Session Manager.

data "aws_ssm_parameter" "al2023_arm64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/arc-cloud/${var.environment}"
  retention_in_days = 14
}

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "server" {
  name               = "arc-cloud-${var.environment}-server"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_role_policy_attachment" "server_ssm" {
  role       = aws_iam_role.server.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "server" {
  statement {
    sid       = "ReadOwnSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.app.arn, aws_db_instance.main.master_user_secret[0].secret_arn]
  }
  statement {
    sid       = "ShipContainerLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
    resources = ["${aws_cloudwatch_log_group.app.arn}:*"]
  }
}

resource "aws_iam_role_policy" "server" {
  name   = "arc-cloud-server"
  role   = aws_iam_role.server.id
  policy = data.aws_iam_policy_document.server.json
}

resource "aws_iam_instance_profile" "server" {
  name = "arc-cloud-${var.environment}-server"
  role = aws_iam_role.server.name
}

locals {
  api_host  = "api.${var.zone_name}"
  mqtt_host = "mqtt.${var.zone_name}"
}

resource "aws_instance" "server" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.value
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public[0].id
  vpc_security_group_ids = [aws_security_group.server.id]
  iam_instance_profile   = aws_iam_instance_profile.server.name

  metadata_options {
    http_tokens                 = "required" # IMDSv2 only
    http_put_response_hop_limit = 1          # containers on the bridge network cannot reach the instance role
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = 30
    encrypted   = true
  }

  user_data = templatefile("${path.module}/user_data.sh.tftpl", {
    region         = var.region
    log_group      = aws_cloudwatch_log_group.app.name
    git_repository = var.github_repository
    git_ref        = var.app_git_ref
    config = {
      AWS_REGION     = var.region
      APP_SECRET_ARN = aws_secretsmanager_secret.app.arn
      DB_SECRET_ARN  = aws_db_instance.main.master_user_secret[0].secret_arn
      DB_HOST        = aws_db_instance.main.address
      DB_PORT        = tostring(aws_db_instance.main.port)
      DB_NAME        = aws_db_instance.main.db_name
      API_HOST       = local.api_host
      MQTT_HOST      = local.mqtt_host
      CONSOLE_ORIGIN = "https://${var.zone_name}"
      ACME_EMAIL     = var.alert_email
      LOG_GROUP      = aws_cloudwatch_log_group.app.name
      GIT_REPOSITORY = var.github_repository
    }
  })
  user_data_replace_on_change = false # app updates go through deploy/aws/arc-deploy.sh, not instance replacement

  tags = { Name = "arc-cloud-${var.environment}" }

  lifecycle {
    ignore_changes = [ami, user_data] # never replace the server just because a newer AMI exists
  }

  # Boot only once the Wix → Route 53 delegation is proven live (the console certificate validated through it),
  # so Caddy can obtain Let's Encrypt certificates for api./mqtt. on first boot.
  depends_on = [aws_acm_certificate_validation.console]
}

resource "aws_eip" "server" {
  domain   = "vpc"
  instance = aws_instance.server.id
  tags     = { Name = "arc-cloud-${var.environment}" }
}

# Self-healing: recover onto healthy hardware on a host failure; reboot on an OS-level failure.
resource "aws_cloudwatch_metric_alarm" "server_recover" {
  alarm_name          = "arc-cloud-${var.environment}-server-system-check"
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed_System"
  dimensions          = { InstanceId = aws_instance.server.id }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  alarm_actions       = ["arn:aws:automate:${var.region}:ec2:recover", aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "server_reboot" {
  alarm_name          = "arc-cloud-${var.environment}-server-instance-check"
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed_Instance"
  dimensions          = { InstanceId = aws_instance.server.id }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  alarm_actions       = ["arn:aws:automate:${var.region}:ec2:reboot", aws_sns_topic.alerts.arn]
}
