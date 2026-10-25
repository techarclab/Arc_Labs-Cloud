# GitHub Actions deploy role (OIDC, no stored keys). Only workflows running in the GitHub environment
# "pilot" of this repository can assume it; protect that environment with required reviewers.
#
# GitHub issues this repository's tokens with an ID-based subject:
#   repo:OWNER@OWNER_ID/NAME@REPO_ID:environment:ENV
# (confirmed from the AssumeRoleWithWebIdentity event in CloudTrail). The numeric IDs never move to a new
# repository, so a deleted or renamed repo re-created under the same name cannot assume this role.
locals {
  github_oidc_subject = format("repo:%s@%s/%s@%s:environment:%s",
    split("/", var.github_repository)[0], var.github_owner_id,
    split("/", var.github_repository)[1], var.github_repository_id,
  var.environment)
}

data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

data "aws_iam_policy_document" "deploy_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [data.aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = [local.github_oidc_subject]
    }
  }
}

resource "aws_iam_role" "deploy" {
  name                 = "arc-cloud-${var.environment}-github-deploy"
  assume_role_policy   = data.aws_iam_policy_document.deploy_assume.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "deploy" {
  statement {
    sid       = "ConsoleUpload"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.console.arn]
  }
  statement {
    sid       = "ConsoleObjects"
    actions   = ["s3:PutObject", "s3:DeleteObject", "s3:GetObject"]
    resources = ["${aws_s3_bucket.console.arn}/*"]
  }
  statement {
    sid       = "ConsoleCache"
    actions   = ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"]
    resources = [aws_cloudfront_distribution.console.arn]
  }
  statement {
    sid     = "DeployServer"
    actions = ["ssm:SendCommand"]
    resources = [
      aws_instance.server.arn,
      "arn:aws:ssm:${var.region}::document/AWS-RunShellScript",
    ]
  }
  statement {
    sid       = "DeployStatus"
    actions   = ["ssm:GetCommandInvocation", "ssm:ListCommandInvocations"]
    resources = ["*"] # these actions do not support resource-level permissions
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "arc-cloud-deploy"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}
