variable "environment" {
  type        = string
  description = "Deployment environment."
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production"
  }
}

variable "cloudflare_account_id" {
  type        = string
  description = "Cloudflare account that owns R2."
  sensitive   = true
}

variable "cloudflare_zone_id" {
  type        = string
  description = "Cloudflare zone for public records."
  sensitive   = true
}

variable "dns_zone" {
  type        = string
  description = "Base DNS zone without a trailing dot."
}

variable "web_origin_hostname" {
  type        = string
  description = "Ingress hostname reached through Cloudflare."
}

variable "r2_location" {
  type        = string
  description = "R2 location hint."
  default     = "APAC"
}

variable "quarantine_abort_multipart_seconds" {
  type        = number
  description = "Age after which incomplete quarantine multipart uploads are aborted."
  validation {
    condition     = var.quarantine_abort_multipart_seconds >= 86400
    error_message = "quarantine multipart retention must be at least one day"
  }
}

variable "quarantine_retention_seconds" {
  type        = number
  description = "Age after which quarantine objects are deleted."
  validation {
    condition     = var.quarantine_retention_seconds >= 604800
    error_message = "quarantine object retention must be at least seven days"
  }
}

variable "published_lock_seconds" {
  type        = number
  description = "Minimum lock age for digest-addressed published objects."
  validation {
    condition     = var.published_lock_seconds >= 604800
    error_message = "published object lock must be at least seven days"
  }
}
