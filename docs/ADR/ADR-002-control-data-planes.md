# ADR-002: Separate control and data planes

Status: Accepted

Metadata and authorization use a stateless control-plane API. Artifact bytes
use direct multipart upload to quarantine storage and immutable CDN delivery
from published storage. The API never proxies public package bytes.

This keeps API latency and cost independent from package size, permits HTTP
Range/resume at the edge, and prevents a download surge from exhausting API
connections. Short-lived edge tickets protect restricted artifacts.
