locals {
  prefix            = "assetlibrary-${var.environment}"
  web_hostname      = var.environment == "production" ? "assets.${var.dns_zone}" : "assets-${var.environment}.${var.dns_zone}"
  download_hostname = var.environment == "production" ? "downloads.${var.dns_zone}" : "downloads-${var.environment}.${var.dns_zone}"
}

resource "cloudflare_r2_bucket" "quarantine" {
  account_id    = var.cloudflare_account_id
  name          = "${local.prefix}-quarantine"
  location      = var.r2_location
  storage_class = "Standard"
}

resource "cloudflare_r2_bucket" "published" {
  account_id    = var.cloudflare_account_id
  name          = "${local.prefix}-published"
  location      = var.r2_location
  storage_class = "Standard"
}

resource "cloudflare_r2_bucket_lifecycle" "quarantine" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.quarantine.name
  rules = [{
    id         = "quarantine-retention"
    enabled    = true
    conditions = { prefix = "quarantine/" }
    abort_multipart_uploads_transition = {
      condition = {
        type    = "Age"
        max_age = var.quarantine_abort_multipart_seconds
      }
    }
    delete_objects_transition = {
      condition = {
        type    = "Age"
        max_age = var.quarantine_retention_seconds
      }
    }
  }]
}

resource "cloudflare_r2_bucket_lock" "published" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.published.name
  rules = [{
    id      = "published-retention"
    enabled = true
    prefix  = "sha256/"
    condition = {
      type            = "Age"
      max_age_seconds = var.published_lock_seconds
    }
  }]
}

resource "cloudflare_dns_record" "web" {
  zone_id = var.cloudflare_zone_id
  name    = local.web_hostname
  content = var.web_origin_hostname
  type    = "CNAME"
  proxied = true
  ttl     = 1
}

output "quarantine_bucket_name" {
  value = cloudflare_r2_bucket.quarantine.name
}

output "published_bucket_name" {
  value = cloudflare_r2_bucket.published.name
}

output "web_hostname" {
  value = local.web_hostname
}

output "download_hostname" {
  value = local.download_hostname
}

output "quarantine_retention_seconds" {
  value = var.quarantine_retention_seconds
}

output "published_lock_seconds" {
  value = var.published_lock_seconds
}
