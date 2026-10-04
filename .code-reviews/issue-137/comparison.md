## Comparison

This review compares the four bound implementation pins for issue 137:
- Cursor: `13804a10c6fdb0965c79d016559397fe4adf304b`
- Claude: `f8543ea6bd7fe695ecb1b25638a29100d67cff3c`
- Codex: `a4d2b46480d89b5dfcd79991e520530b4ed427ac`
- Antigravity: `b915e8c9f45a032a4afa1498ef229083de8ac1e8`

All implementations implement an on-demand plan amendment protocol detour (`R4.amend-ballot`) callable during implementation or revision to expand the effective approved file map without modifying the immutable pinned plan. However, the four implementations exhibit critical differences in protocol schema compliance, validation rigor, and regression testing scope.

### Findings

#### Finding 1: Claude uses non-standard "reject" disposition instead of plan-specified "revise"
- **File path and line number:** `src/protocol.ts:184` and `src/protocol.ts:197` in `f8543ea6bd7fe695ecb1b25638a29100d67cff3c`
- **Rule that must hold:** In accordance with Codex's selected plan (Section 2: "with private JSON `{ actionId, disposition: "approve" | "revise", rationale }`. Here `revise` rejects the proposal with actionable reasons."), the private amendment ballot response and coordinator-published canonical ballot schemas must accept `"approve" | "revise"` dispositions.
- **Concrete failure:** Claude specifies `disposition: z.enum(["approve", "reject"])` in both `amendmentBallotResponseSchema` and `amendmentBallotArtifactSchema`. When an agent submits a valid amendment ballot using the plan-mandated `"revise"` disposition, schema validation fails with `invalid_enum_value`, preventing the rejection response from being parsed or accepted.
- **Illustrative test:**
```typescript
it("accepts revise disposition in amendment ballot response", () => {
  const result = amendmentBallotResponseSchema.safeParse({
    actionId: "10000000-0000-4000-8000-000000000001",
    disposition: "revise",
    rationale: "Proposed additions exceed original scope."
  });
  expect(result.success).toBe(true);
});
```

#### Finding 2: Codex names explanation field "rationale" in planAmendmentRequestSchema
- **File path and line number:** `src/protocol.ts:104` in `a4d2b46480d89b5dfcd79991e520530b4ed427ac`
- **Rule that must hold:** Per Codex's selected plan (Section 1: "The request contains the common issue/session/agent fields, current action ID, the current input-set hash, a coordinator-supplied `scopeHash`, a nonblank explanation of the discovered omission, and `additionalPaths` entries..."), the `plan-amendment-request` artifact schema must define the explanation property as `explanation`.
- **Concrete failure:** Codex declared `rationale: amendmentReasonSchema` in `planAmendmentRequestSchema` instead of `explanation`. Because the schema is marked `.strict()`, any agent emitting a conforming request with the plan-specified `explanation` key is rejected during evidence observation for unrecognized key `explanation` and missing required key `rationale`.
- **Illustrative test:**
```typescript
it("validates explanation field in plan-amendment-request schema", () => {
  const result = planAmendmentRequestSchema.safeParse({
    protocolVersion: 1,
    issue: 137,
    issueSessionId: "issue-137:3d1bf995c2327978374d863c16828a24e311c159",
    agent: "antigravity",
    actionId: "10000000-0000-4000-8000-000000000001",
    inputSetHash: "a".repeat(64),
    scopeHash: "b".repeat(64),
    explanation: "Discovered an overlooked test file required for verification.",
    additionalPaths: [{ path: "test/extra.test.ts", reason: "unit tests" }]
  });
  expect(result.success).toBe(true);
});
```

#### Finding 3: Cursor omitted end-to-end Git integration coverage and misnamed ballot artifact
- **File path and line number:** `test/integration.test.ts` (omitted) and `src/protocol.ts:168` in `13804a10c6fdb0965c79d016559397fe4adf304b`
- **Rule that must hold:** Item 6 of the selected plan's test plan explicitly requires extending `test/integration.test.ts` with an omitted test-file request during implementation, private unanimous votes, coordinator evidence publication, and implementation of the newly approved path. Additionally, published amendment ballot artifacts must carry `artifact: "amendment-ballot"`.
- **Concrete failure:** Cursor omitted `test/integration.test.ts` entirely (touching only 26 files), omitting verification that the real multi-agent bare-origin Git workflow correctly executes the detour and permits product commits on newly approved paths. Additionally, Cursor named the published artifact `plan-amendment-ballot`, causing mismatch with the coordinator's `amendment-ballot` convention.
- **Illustrative test:**
```typescript
it("recognizes canonical amendment-ballot published artifact discriminator", () => {
  const result = publishedArtifactSchema.safeParse({
    protocolVersion: 2,
    issue: 137,
    issueSessionId: "issue-137:3d1bf995c2327978374d863c16828a24e311c159",
    agent: "codex",
    actionId: "10000000-0000-4000-8000-000000000001",
    responseSha256: "a".repeat(64),
    rationale: "Addition is necessary.",
    inputSetHash: "b".repeat(64),
    artifact: "amendment-ballot",
    sequence: 1,
    request: { agent: "claude", commitSha: "c".repeat(40), path: ".signals/issue-137/implementation-ready-claude.json" },
    plans: [{ agent: "codex", commitSha: "d".repeat(40), path: ".plans/issue-137/plan.md" }],
    disposition: "approve"
  });
  expect(result.success).toBe(true);
});
```

### Overall Comparison and Scope Discipline

| Criteria | Cursor (`13804a10`) | Claude (`f8543ea6`) | Codex (`a4d2b464`) | Antigravity (`b915e8c9`) |
| --- | --- | --- | --- | --- |
| **Plan Schema Alignment** | Uses `plan-amendment-ballot` instead of `amendment-ballot`; lax path validation | Uses `"reject"` instead of `"revise"` disposition | Uses `"rationale"` instead of `"explanation"` in request | Full schema alignment (`explanation`, `"approve" \| "revise"`, `amendment-ballot`) |
| **Path Constraint Enforcement** | Relies on generic `repositoryPathSchema` without directory / glob / coordination rejection | Rejects absolute/traversing/globs; limits to 32 paths | Rejects regex characters, directories, and coordination namespaces | Comprehensive literal path validation (no slashes, globs, coordination prefixes, duplicate checks) |
| **Detour & State Handling** | Implements `R4.amend-ballot` and sequence handling | Implements `R4.amend-ballot` and sequence handling | Implements `R4.amend-ballot` and sequence handling | Implements `R4.amend-ballot` detour, monotonic sequence, and clean state recovery |
| **Dynamic Scope Expansion** | Adds `scopeAmendments` to effective file map | Adds `scopeAmendments` to effective file map | Adds `scopeAmendments` to effective file map | Integrates `scopeAmendments` in `resolveApprovedPaths`, `approvedPathsForOrder`, and `buildOrder` |
| **Drop & Reselection Reset** | Resets detour on drop | Resets detour on drop | Resets detour on drop | Resets pending detour on drop; purges approved scope amendments on plan reselection |
| **Test Suite Coverage** | Touches 26 files; **omits `test/integration.test.ts`** | Touches all 27 files with comprehensive coverage | Touches all 27 files with comprehensive coverage | Touches all 27 files with full unit, CLI, run loop, and end-to-end Git integration coverage |
