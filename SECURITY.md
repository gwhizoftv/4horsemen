# Four Horsemen security policy

## Supported versions

Report issues against current `main` or the latest published `0.0.x` tag, if
one exists. Reproduce on current `main` when possible; older snapshots have no
promised backport support. This pre-1.0 project does not promise a response SLA.

## Private reporting

Do not put vulnerability details, credentials, transcripts or private product
content in a public issue or pull request.

When enabled, use **Security → Report a vulnerability** in the
[repository's private reporting form](https://github.com/gwhizoftv/4horsemen/security/advisories/new).
Include the affected commit/version, platform, reproduction steps, expected
boundary and observed impact, with secrets redacted. Bootstrap, Git hooks,
agent permissions and the runtime-state isolation boundary are in scope, as
are other vulnerabilities in Four Horsemen.

**Release gate: reporting availability is not yet verified by this change.**
Before public release, the maintainer must enable GitHub private vulnerability
reporting and verify the form from a reporter account, or replace these
instructions with a verified private contact. If the form is unavailable, do
not disclose the vulnerability publicly; a public request to enable private
reporting must contain no vulnerability details. This policy file alone does
not enable the feature. The remaining release work is tracked in
[issue #139](https://github.com/gwhizoftv/4horsemen/issues/139).
