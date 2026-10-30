# Security policy

## Reporting a vulnerability

Please send suspected security vulnerabilities privately to
[yangpf@varve.ai](mailto:yangpf@varve.ai). Reports in English or Chinese are welcome.
Do not disclose vulnerability details in public issues, pull requests or discussions.

Include, where available:

- The affected ADIT version, operating system and Node.js version.
- The affected feature, expected behavior and observed impact.
- Minimal reproduction steps or a proof of concept using synthetic data.
- Relevant logs or screenshots with credentials and personal information removed.

Do not send real API keys, device tokens, Cloud credentials, complete conversation
archives or local databases in the initial report. Describe what additional evidence
is available so maintainers can arrange a suitable way to share it privately.

Maintainers will investigate the report and coordinate remediation and disclosure
with the reporter. There is no guaranteed response or resolution deadline.
Please coordinate public disclosure with maintainers so users can receive a fix.

## Versions and scope

Please reproduce on the latest stable release when practical and report the exact
version. Older-version reports are welcome, but fixes normally target a new stable
release; older release lines do not have a separate maintenance commitment.

This policy covers ADIT Core's published packages, CLI, local workbench and Cloud
integration code in this repository. For a suspected third-party dependency issue,
include the package and version and explain its impact on ADIT; maintainers can
coordinate with the upstream project.

For ordinary bugs or feature requests, use
[GitHub issues](https://github.com/VARVE-ai/adit-core/issues). Remove private data
before posting. A security policy is a reporting channel, not a claim that all
dependencies are free of vulnerabilities.
