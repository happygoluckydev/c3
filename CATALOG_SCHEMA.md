# c2/c3 catalog schema

This document defines the platform-neutral catalog contract shared by c2 and c3.
Platform adapters may add fields, but they must preserve the meanings below.

## Entry fields

Every normalized catalog entry contains:

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Stable identity in `kind:name` form. |
| `platform` | `codex` \| `claude-code` | Platform on which the capability is usable. |
| `kind` | string | Native capability type, such as `skill`, `plugin`, `agent`, or `mcp`. |
| `name` | string | Human-readable capability name. |
| `description` | string | Short searchable description. |
| `source` | string | Source catalog, repository, or local installation class. |
| `tags` | string[] | Searchable source-provided or normalized labels. |
| `availability` | enum | Whether it is `built-in`, `installed`, `installable`, `copy-and-adapt`, `authoring-required`, or `unknown`. |
| `packaging` | enum | Whether it is `built-in`, `standalone`, `plugin`, `plugin-component`, or `unknown`. |
| `domain` | string | Normalized task domain, or `unknown`. |
| `execution` | enum | `prompt`, `isolated-agent`, `deterministic-hook`, `external-service`, `background-monitor`, or `unknown`. |
| `sourceClass` | enum | Publisher provenance: `official`, `community`, or `unknown`. |
| `license` | string | SPDX identifier when the original source provides one; otherwise `unknown`. |
| `maturity` | enum | `stable`, `experimental`, `deprecated`, or `unknown`. |
| `surface` | string[] | Applicable product surfaces, or `["unknown"]`. |
| `parentPlugin` | string \| null | Owning plugin for a bundled component. |
| `permissions` | string[] | Declared access classes, or `["unknown"]`. |
| `install` | string | Human-reviewable setup guidance; never executed by c2/c3. |

Optional fields:

- `prerequisites`: setup requirements that must be satisfied separately.
- `fulltext`: clipped local retrieval text. It is search-only and must not be emitted by `--get`.

## Compatibility rules

- `availability` and `packaging` are independent. The legacy `distribution` field is read only
  as a migration input and must not be emitted by newly built catalogs.
- Legacy `distribution` migration:
  - packaging-shaped values (`builtin`/`built-in`/`standalone`/`plugin`/`plugin-component`)
    become `packaging`, with `availability` inferred as `built-in`, `installed`, or `installable`
  - availability-shaped values (`installed`/`installable`/`copy-and-adapt`/`built-in`)
    become `availability`, with `packaging` set to `built-in` or `unknown`
- Unknown facts stay `unknown`; publisher identity, license, maturity, and permissions are never
  inferred from a marketplace listing alone.
- Dedupe keys and ID lookup are case-insensitive, while the original display casing is preserved.
- A bare name may be used with `--get` only when it identifies one record. Otherwise callers must
  pass the stable `kind:name` ID returned by `--all`.
- Platform-specific kinds and sources are valid extensions. Their shared fields keep the meanings
  above.
- MCP `install` strings must not embed registry-supplied server names. Use a placeholder such as
  `<name>` and only interpolate values that passed install-string safety checks.

## Catalog metadata

`meta.json` contains `schemaVersion`, `builtAt`, `total`, `counts`, `fulltext`, `vectors`, and
`errors`. The current shared schema version is `3`. A missing or different `schemaVersion` makes
the catalog stale and triggers a rebuild.
