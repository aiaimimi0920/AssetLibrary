module "edge" {
  source = "../../modules/edge"

  environment                        = "production"
  cloudflare_account_id              = var.cloudflare_account_id
  cloudflare_zone_id                 = var.cloudflare_zone_id
  dns_zone                           = var.dns_zone
  web_origin_hostname                = var.web_origin_hostname
  quarantine_abort_multipart_seconds = var.quarantine_abort_multipart_seconds
  quarantine_retention_seconds       = var.quarantine_retention_seconds
  published_lock_seconds             = var.published_lock_seconds
}
