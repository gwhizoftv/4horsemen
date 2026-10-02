# Security policy

## Supported versions

Only the latest commit on `main` (the latest `0.0.N` release) receives
security fixes.

## Reporting a vulnerability

Report privately with GitHub's private vulnerability reporting: open the
repository's **Security** tab and choose **Report a vulnerability**. Do not
open a public issue, pull request, or discussion with vulnerability details.

If that button is not shown, private reporting is not enabled yet. Open a
public issue that asks only for a private contact channel, and include no
details of the vulnerability.

Expect an acknowledgement within a week.

## Scope

In scope:

- the agent git hooks under `githooks/` and the hook shim
- `scripts/bootstrap.sh` and the install, onboard, and uninstall commands
- the boundary that keeps runtime state, credentials, and product secrets out
  of agent clones and out of this repository
- the evidence checks that decide which pushed commit advances

The behaviour of third-party agent harnesses (Claude, Codex, Cursor,
Antigravity) and of the product repositories coordination drives is out of
scope.
