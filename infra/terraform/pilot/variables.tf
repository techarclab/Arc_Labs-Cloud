variable "account_id" {
  type        = string
  description = "Dedicated ARC Cloud AWS account. Terraform refuses to touch any other account."
  default     = "756751967044"
}

variable "region" {
  type    = string
  default = "ap-south-1"
}

variable "environment" {
  type    = string
  default = "pilot"
}

variable "zone_name" {
  type        = string
  description = "Console hostname; the API and broker live at api.<this> and mqtt.<this>. DNS records are added in Wix."
  default     = "arcloud.arclabs.in"
}

variable "alert_email" {
  type        = string
  description = "Receives budget, health and uptime alert emails (confirm both SNS subscription mails: ap-south-1 and us-east-1). Also Caddy's ACME account contact; Let's Encrypt no longer sends expiry emails (ended June 2025), arc-monitor alerts instead."
}

variable "monthly_budget" {
  type        = number
  description = "AWS Budgets limit in budget_currency. ₹5,000 incl. 18% GST ≈ $44 of usage at ₹95/$."
  default     = 44
}

variable "budget_currency" {
  type        = string
  description = "USD for most accounts. If the account bills through AWS India (AISPL) and Budgets rejects USD, use INR."
  default     = "USD"
}

variable "instance_type" {
  type    = string
  default = "t4g.medium" # 2 vCPU (burstable), 4 GiB: EMQX + API + worker + Caddy
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "db_allocated_storage_gb" {
  type    = number
  default = 20
}

variable "github_repository" {
  type        = string
  description = "owner/name, exactly as GitHub reports it (case-sensitive in the OIDC subject)."
  default     = "techarclab/Arc_Labs-Cloud"
}

variable "github_owner_id" {
  type        = string
  description = "Numeric GitHub ID of the repository owner: gh api repos/OWNER/NAME --jq .owner.id"
  default     = "166861876"
}

variable "github_repository_id" {
  type        = string
  description = "Numeric GitHub ID of the repository: gh api repos/OWNER/NAME --jq .id"
  default     = "1415316437"
}

variable "app_git_ref" {
  type        = string
  description = "Git branch/tag the server deploys on first boot. Later deploys pass a ref explicitly."
  default     = "main"
}

variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}
