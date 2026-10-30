# Third-party notices

## ADIT code and third-party components

ADIT's original code is distributed under the [MIT license](LICENSE). That license
does not replace the licenses, terms, copyright notices or trademark rights of
third-party components. Package metadata declaring ADIT as MIT refers to ADIT's
own code, not to every dependency installed with it.

The inventory below records the installed versions reviewed on 2026-10-30 against
the repository dependency manifests and lockfile. Version ranges may resolve to
newer versions when users install the published CLI. The license and notices
shipped with each resolved dependency remain authoritative.

## Claude Agent SDK

`@anthropic-ai/claude-agent-sdk` 0.3.179 is **not covered by ADIT's MIT license**.
Its distributed `LICENSE.md` states that copyright belongs to Anthropic PBC, all
rights are reserved, and use is subject to the agreements linked from
[Anthropic's legal and compliance documentation](https://code.claude.com/docs/en/legal-and-compliance).
See also the [upstream SDK license](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/LICENSE.md).

ADIT declares this SDK as an npm dependency; npm installs the SDK and its applicable
platform packages separately. Their original license notices must be retained.
Using or redistributing ADIT does not grant additional rights to the SDK, Claude
Code, Anthropic services or other providers' services. Review the applicable
upstream terms for your account, authentication and deployment arrangement.

The separate `@anthropic-ai/sdk` API client is MIT-licensed; it must not be confused
with the Claude Agent SDK above.

## Direct dependency inventory

Internal `@varveai/adit-*` packages use ADIT's MIT license and are omitted here.

| Dependency | Reviewed version | Declared license / terms |
| --- | --- | --- |
| `@anthropic-ai/claude-agent-sdk` | 0.3.179 | Anthropic terms; see above |
| `@anthropic-ai/sdk` | 0.104.2 | MIT |
| `acorn` | 8.19.0 | MIT |
| `better-sqlite3` | 13.0.3 | MIT; retain bundled component notices too |
| `commander` | 13.1.0 | MIT |
| `fzstd` | 0.1.1 | MIT |
| `ink` | 5.2.1 | MIT |
| `ink-spinner` | 5.0.0 | MIT |
| `parse5` | 8.0.1 | MIT |
| `picocolors` | 1.1.1 | ISC |
| `react` | 18.3.1 | MIT |
| `ulid` | 2.4.0 | MIT |
| `ws` | 8.20.0 | MIT |
| `badge-maker` | 6.0.0 | MIT OR Apache-2.0 |
| `fflate` | 0.8.3 | MIT |
| `lucide-react` | 0.468.0 | ISC; upstream notice also identifies Feather portions |
| `react-dom` | 18.3.1 | MIT |
| `react-markdown` | 10.1.0 | MIT |
| `remark-gfm` | 4.0.1 | MIT |
| `@lobehub/icons-static-svg` (copied icon assets) | 1.94.0 | MIT; brand rights remain with their owners |

## Bundled workbench, share renderer and icons

The CLI includes built workbench assets and a share renderer containing third-party
code. [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt) preserves license texts and
copyright notices for the reviewed local-web dependency closure, including
transitive dependencies and peers. This is a conservative notice inventory: some
listed packages provide types or code removed during bundling. It is not an
inventory of all separately installed CLI dependencies or all development tools.
For those packages, retain their own distributed license and notice files.

Agent icons are derived from `@lobehub/icons-static-svg`; the existing LobeHub MIT
notice is retained in `local-assets/web/agent-icons.LICENSE.txt` in the CLI package
and in the source tree at `packages/local-web/public/agent-icons.LICENSE.txt`.
ADIT converts icons to an SVG sprite, adjusts IDs and sizing, and adapts the Kimi
fill for themes. ADIT also patches `char-width-table-consumer` 1.0.0 to defer its
Node.js file-loading imports; its original license is retained in the notice file.
The `anafanafo` upstream notice reserves rights to Verdana to Microsoft Corp.
Brand names and logos identify integrations and do not imply endorsement or grant
trademark rights.

## Maintaining and redistributing notices

- When changing dependencies, the lockfile, copied assets or bundling, review this
  inventory and refresh the bundled license texts from the exact installed packages.
  Keep complete copyright and permission notices, including relevant README notices
  when a package does not ship a standalone license file.
- Retain the original license/notice files for separately installed dependencies,
  including native libraries and platform-specific SDK packages.
- The existing package-document preparation step copies this file, the bundled
  license texts and the security policy into the CLI package. Inspect the packed
  archive before release; this document does not itself verify redistribution rights
  under third-party service agreements.
