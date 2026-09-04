# ADR-004: Next.js and React web application

Status: Accepted

The web application uses TypeScript, React, and the Next.js App Router. Public
catalog pages use SSR/ISR for discoverability and fast first content. Publisher
and operator pages are authenticated, dynamic, and `no-store`.

The application uses Neuro design tokens and accessibility rules. Multi-instance
deployments require a shared cache handler plus explicit CDN purge for catalog
publication, suspension, and revocation events.
