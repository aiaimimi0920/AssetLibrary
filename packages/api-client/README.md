# AssetLibrary TypeScript API client

This private package exposes `openapi-fetch` client factories backed by generated
OpenAPI path types. Generation is split by public, consumer, Publisher resource
lifecycle, and Operator resource lifecycle so every checked-in generated file
remains below the repository's 700-line hard limit.

```powershell
pnpm install --frozen-lockfile
pnpm generate:check
pnpm typecheck
```

Run `pnpm generate` after changing `contracts/openapi`. CI regenerates every
domain in memory and performs a byte-for-byte comparison with `src/generated`.
The generated types make request paths, parameters, bodies, and response shapes
compile-time safe; they do not validate an untrusted HTTP response at runtime.
Browser and server consumers must retain a strict runtime parser at their trust
boundary, as the existing AssetLibrary web clients do.

Authentication is intentionally not embedded. Callers provide their own
`ClientOptions`, middleware, and bearer acquisition. In particular, browser
code must not receive Publisher or Operator Account Service credentials.
