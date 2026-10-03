# Scoped Next lint glob replacement

The Web lockfile no longer contains `braces` 3.0.3, affected by
GHSA-vfj7-8cjw-p6xm (CVE-2026-93687). No advisory is ignored and no lint rule is
disabled. `pnpm` replaces only `@next/eslint-plugin-next@16.3.6>fast-glob` with
the existing, integrity-pinned `tinyglobby@0.2.17` implementation.

This is not a general fast-glob drop-in replacement. The pinned Next plugin has
one consumer: `dist/utils/get-root-dirs.js`, calling `globSync` with
`onlyDirectories: true`. Its only rule consumer joins these directories with
`pages`, `src/pages`, `app` and `src/app` before filesystem access. tinyglobby
returns relative, slash-suffixed paths for absolute patterns; these resolve to
the same directories in this consumer. Path strings themselves are not claimed
to be identical.

`pnpm lint` first runs `tests/lint-glob-contract.mjs`, checking the installed
implementation, exact owner/version scope, absence of the vulnerable dependency
chain, plugin usage, directory identities and the real
`@next/next/no-html-link-for-pages` rule. It then runs the unchanged ESLint
ruleset. The existing Web unit, type, build and browser CI gates remain enabled.

Recheck this contract whenever upgrading Next/its ESLint plugin. Do not broaden
the override to other fast-glob consumers. Remove it when an upstream version
has a safe dependency graph and the same lint behavior. Rollback requires
reverting both package.json and the generated pnpm lockfile, but restoring the
affected dependency must not bypass the security gate. No runtime protocol,
database, account, deployment or production-data change is involved.
