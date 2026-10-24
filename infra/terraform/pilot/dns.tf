# Route 53 zone for arcloud.arclabs.in, delegated from Wix with four NS records (see outputs.wix_ns_records).
# arclabs.in itself (the website) stays on Wix.

resource "aws_route53_zone" "main" {
  name    = var.zone_name
  comment = "ARC Cloud ${var.environment} (delegated from Wix)"
}

resource "aws_route53_record" "api" {
  zone_id = aws_route53_zone.main.zone_id
  name    = local.api_host
  type    = "A"
  ttl     = 300
  records = [aws_eip.server.public_ip]
}

resource "aws_route53_record" "mqtt" {
  zone_id = aws_route53_zone.main.zone_id
  name    = local.mqtt_host
  type    = "A"
  ttl     = 300
  records = [aws_eip.server.public_ip]
}

# Only these CAs may issue certificates under arcloud.arclabs.in: Let's Encrypt (server, via Caddy) and
# Amazon (CloudFront). Device firmware trusts ISRG Root X1 and Amazon Root CA 1/3, so this also keeps
# every certificate devices see on a root they pin.
resource "aws_route53_record" "caa" {
  zone_id = aws_route53_zone.main.zone_id
  name    = var.zone_name
  type    = "CAA"
  ttl     = 3600
  records = ["0 issue \"letsencrypt.org\"", "0 issue \"amazon.com\"", "0 iodef \"mailto:${var.alert_email}\""]
}
