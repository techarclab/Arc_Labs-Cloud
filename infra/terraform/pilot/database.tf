# RDS PostgreSQL 16, Single-AZ for the pilot (Multi-AZ roughly doubles the cost; enable before paying customers).
# Daily automated backups + point-in-time restore (transaction logs every ~5 minutes) cover RPO/RTO targets.
# The master password is generated and rotated by RDS in Secrets Manager; it never appears in Terraform state.

resource "aws_db_subnet_group" "main" {
  name       = "arc-cloud-${var.environment}"
  subnet_ids = aws_subnet.database[*].id
}

resource "aws_db_parameter_group" "pg16" {
  name   = "arc-cloud-${var.environment}-pg16"
  family = "postgres16"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
    # AWS records this parameter as pending-reboot; leaving apply_method unset (= immediate) made every plan
    # show a change. The value is what matters, and 1 (TLS required) is already in effect.
    apply_method = "pending-reboot"
  }
  parameter {
    name  = "log_min_duration_statement"
    value = "1000" # log statements slower than 1 s
  }
}

resource "aws_db_instance" "main" {
  identifier     = "arc-cloud-${var.environment}"
  engine         = "postgres"
  engine_version = "16"
  instance_class = var.db_instance_class

  db_name                     = "arc_cloud"
  username                    = "arc_admin"
  manage_master_user_password = true

  allocated_storage     = var.db_allocated_storage_gb
  max_allocated_storage = 60
  storage_type          = "gp3"
  storage_encrypted     = true

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.database.id]
  parameter_group_name   = aws_db_parameter_group.pg16.name
  publicly_accessible    = false
  multi_az               = false

  backup_retention_period    = 7
  backup_window              = "20:00-20:30"         # 01:30 IST
  maintenance_window         = "sun:21:00-sun:22:00" # Mon 02:30 IST
  auto_minor_version_upgrade = true
  copy_tags_to_snapshot      = true

  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "arc-cloud-${var.environment}-final"

  lifecycle {
    ignore_changes = [engine_version] # minor upgrades happen in the maintenance window
  }
}

# Application secrets. Generated here, stored in Secrets Manager, read by the server at deploy time.
# They also live in Terraform state, which is why the state bucket is private, encrypted and TLS-only.
resource "random_password" "app" {
  for_each = {
    JWT_SECRET            = 48
    INTERNAL_HOOK_TOKEN   = 40
    MQTT_SERVICE_PASSWORD = 32
    EMQX_API_SECRET       = 40
    EMQX_DASHBOARD_PASS   = 24
    EMQX_NODE_COOKIE      = 32
  }
  length  = each.value
  special = false # values go into URLs, HOCON and colon-separated files
}

resource "aws_secretsmanager_secret" "app" {
  name                    = "arc-cloud/${var.environment}/app"
  description             = "ARC Cloud application secrets (JWT, broker hook token, MQTT service, EMQX API)."
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id     = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({ for k, v in random_password.app : k => v.result })
}
