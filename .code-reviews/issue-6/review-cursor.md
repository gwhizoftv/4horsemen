# Code review: Cursor plan for issue 6

- Reviewed head: `origin/issue-6/cursor` @ `14fdbdc1ffa51865db9e37655db4ad976c4814bf`
- Plan commit: `34c803f5303216470e9bbbc84e0dfe17f447f2fe`
- Baseline: `origin/main` @ `f9d00841db8e5a95acb4e2956266825869e0758c`
- Scope: `.plans/issue-6/plan.md` (later commits add review documents only)
- Reviewer: Codex

## Verdict

**Changes required.** The plan passes the mechanical plan-shape predicate and
covers all R1-R8 surfaces, but its registry placement breaks bootstrap
idempotency and cross-install discovery. Its workspace chooser and runtime path
model also do not safely support the multi-product layout they advertise, and
the proposed digest default lets declarations remove the GitHub issue.

## Findings

### [P1] Preserve an occupied flat workspace when adding a product

**Path:** `.plans/issue-6/plan.md:65-67`. **Rule:** A flat config for another project occupies the root slot, so every additional product sharing that coord-root must be assigned a nested workspace without overwriting the flat config. **Failure:** the proposed write rule chooses flat whenever there are no `workspaces/` children; after product A creates `<coord-root>/config.json`, onboarding product B while no nested directory exists selects the same flat path and replaces A's config. **Test:** onboard A into a fresh coord-root, onboard B into that same root, and require A to remain flat while B is written at `workspaces/<B>/config.json` with both configs still readable.

### [P1] Isolate nested products' issue state and mirrors

**Path:** `.plans/issue-6/plan.md:69-70`. **Rule:** Products sharing an outer coord-root must not share a mirror or an `issue-N` namespace because GitHub issue numbers are repository-local. **Failure:** keeping all issue runtimes at `<coord-root>/issue-N` makes product A issue 42 and product B issue 42 use the same cursors, digest, snapshot, and mirror, so the second start refuses or operates A's session instead of B's. **Test:** start issue 42 for two nested products and assert each resolved workspace has a distinct mirror and `issue-42/start.json` containing its own origin.

### [P1] Keep discovery state outside a bootstrap-managed checkout

**Path:** `.plans/issue-6/plan.md:76-80`. **Rule:** Product discovery state must be shared by whichever coordination checkout launches the daily CLI and must not make a bootstrap-owned Git checkout dirty. **Failure:** writing untracked registry files under `<install-root>/registry/` makes the next bootstrap rerun see `git status --porcelain` output and refuse the required clean fast-forward; onboarding from a developer checkout also writes a different registry from `~/.local/bin/coord`, so the PATH command reports that the product was never onboarded. **Test:** bootstrap, onboard, and bootstrap again with the PATH install, then onboard through a second clean install root and require both invocations to resolve the same product without either checkout becoming dirty.

### [P2] Key registry records by product identity, not project slug

**Path:** `.plans/issue-6/plan.md:79`. **Rule:** Registry storage must distinguish products by canonical product root (or a collision-resistant derivative), because project basenames are not globally unique. **Failure:** `/work/acme/api` and `/work/other/api` both map to `registry/products/api.json`; onboarding the second overwrites the first record, after which `coord N --product /work/acme/api` fails the stamp cross-check or resolves the wrong runtime. **Test:** onboard two repositories with the same basename from different parents and require both `--product` lookups to return their own config paths after restart.

### [P1] Make the issue snapshot independent of `digestPaths`

**Path:** `.plans/issue-6/plan.md:106-108`. **Rule:** The GitHub issue snapshot is a mandatory digest source, while `digestPaths` may contain only optional additional inputs. **Failure:** making the snapshot merely the default `digestPaths` entry lets `--declare` set `digestPaths: []` or a custom list and silently remove the issue from `automationDigest`; two different issue bodies can then produce the same session digest under the same config. **Test:** start with an explicit empty `digestPaths`, change only the fetched issue body, and require both `automationDigestSources` to contain a GitHub issue source and the resulting digests to differ.
