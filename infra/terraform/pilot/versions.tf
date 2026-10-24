terraform {
  required_version = ">= 1.10" # S3 native state locking (use_lockfile)
  required_providers {
    aws    = { source = "hashicorp/aws", version = ">= 6.0, < 7.0" }
    random = { source = "hashicorp/random", version = ">= 3.6, < 4.0" }
  }
  # Partial config: bucket comes from the bootstrap stack. See docs/deploy/aws-pilot.md:
  #   terraform init -backend-config="bucket=arc-cloud-tfstate-<account-id>"
  backend "s3" {
    key          = "pilot/terraform.tfstate"
    region       = "ap-south-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.account_id]
  default_tags {
    tags = { Project = "arc-cloud", Environment = var.environment, ManagedBy = "terraform" }
  }
}

# CloudFront only accepts ACM certificates from us-east-1.
provider "aws" {
  alias               = "us_east_1"
  region              = "us-east-1"
  allowed_account_ids = [var.account_id]
  default_tags {
    tags = { Project = "arc-cloud", Environment = var.environment, ManagedBy = "terraform" }
  }
}
