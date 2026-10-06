variable "cloudflare_account_id" {
  type      = string
  sensitive = true
}

variable "cloudflare_zone_id" {
  type      = string
  sensitive = true
}

variable "dns_zone" {
  type = string
}

variable "web_origin_hostname" {
  type = string
}

variable "quarantine_abort_multipart_seconds" {
  type    = number
  default = 86400
}

variable "quarantine_retention_seconds" {
  type    = number
  default = 604800
}

variable "published_lock_seconds" {
  type    = number
  default = 604800
}
