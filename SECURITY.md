# Security Policy

## Supported versions

Security fixes are accepted for:

- the tip of `main`
- the latest published `0.0.x` tag, when tags exist

Older tags and forks are unsupported unless a maintainer says otherwise.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub’s private vulnerability
reporting for this repository (Security tab → “Report a vulnerability”).

Do **not** open a public GitHub issue, discussion, or pull request that
discloses exploit details.

### In scope

- Install and bootstrap scripts
- Agent git hooks and verification gating
- Boundary between product clones and external runtime state (`coord-runtime`)
- Credential or secret handling in the driver and docs

### Out of scope

- Vulnerabilities only in third-party agent harnesses (Claude, Codex, Cursor,
  Antigravity) that coordination merely launches
- Issues that require an already-compromised machine or stolen GitHub tokens

If private vulnerability reporting is not yet enabled on the repository, contact
a maintainer through a private channel they publish; do not fall back to a
public issue with vulnerability details.
