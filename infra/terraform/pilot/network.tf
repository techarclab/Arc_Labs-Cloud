# Two AZs because RDS requires a subnet group spanning two; the server runs in one public subnet.
# No NAT Gateway (≈$41/month): the server has a public IP for egress; the database has no internet route.

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, 2)
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "arc-cloud-${var.environment}" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "arc-cloud-${var.environment}" }
}

resource "aws_subnet" "public" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index)
  availability_zone = local.azs[count.index]
  tags              = { Name = "arc-cloud-${var.environment}-public-${local.azs[count.index]}" }
}

resource "aws_subnet" "database" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, 10 + count.index)
  availability_zone = local.azs[count.index]
  tags              = { Name = "arc-cloud-${var.environment}-db-${local.azs[count.index]}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
  tags = { Name = "arc-cloud-${var.environment}-public" }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# Database subnets use a route table with no internet route.
resource "aws_route_table" "database" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "arc-cloud-${var.environment}-db" }
}

resource "aws_route_table_association" "database" {
  count          = 2
  subnet_id      = aws_subnet.database[count.index].id
  route_table_id = aws_route_table.database.id
}

# The VPC's default security group allows all traffic between its members; strip it so nothing uses it by accident.
resource "aws_default_security_group" "default" {
  vpc_id = aws_vpc.main.id
}

resource "aws_security_group" "server" {
  name        = "arc-cloud-${var.environment}-server"
  description = "ARC Cloud server: HTTPS (API), MQTT over TLS (devices), HTTP (ACME challenge + redirect). No SSH: use SSM Session Manager."
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "arc-cloud-${var.environment}-server" }
}

resource "aws_vpc_security_group_ingress_rule" "server" {
  for_each          = { https = 443, mqtts = 8883, http = 80 }
  security_group_id = aws_security_group.server.id
  description       = each.key
  ip_protocol       = "tcp"
  from_port         = each.value
  to_port           = each.value
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "server_all" {
  security_group_id = aws_security_group.server.id
  description       = "Package/image downloads, Let's Encrypt, AWS APIs, webhooks, RDS"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_security_group" "database" {
  name        = "arc-cloud-${var.environment}-db"
  description = "PostgreSQL from the ARC Cloud server only"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "arc-cloud-${var.environment}-db" }
}

resource "aws_vpc_security_group_ingress_rule" "database_from_server" {
  security_group_id            = aws_security_group.database.id
  description                  = "PostgreSQL from the server"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.server.id
}
