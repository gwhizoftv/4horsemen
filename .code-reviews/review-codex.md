**`githooks/lib/verify.mjs:384`**
- **Rule:** A commit that only moves coordination evidence changes no product code, so the project's own checks must be skipped.
- **Failure:** The `coordinationOnly` regex `/^(?:\.plans|\.signals|\.code-reviews)\//` omits the `.amendments/` and `.escalations/` evidence paths. If an agent commits a change that only touches these directories, `verify.mjs` will incorrectly classify it as product code and run the heavy project checks, needlessly slowing down the workflow and potentially blocking on unrelated test failures.
- **Fix sketch:**
  ```javascript
  const coordinationOnly = (paths) =>
    paths.length > 0 && paths.every((path) => /^(?:\.plans|\.signals|\.code-reviews|\.amendments|\.escalations)\//.test(path));
  ```
