.plans/issue-6/plan.md:361
**Rule**: The product-master footprint must remain zero, and a human product clone must remain unaffected and contain no coordination metadata after onboarding.
**Failure**: Storing a "product-local config key" (such as writing to the product clone's `.git/config`) mutates the human clone, directly violating the requirement that the product clone remains coordination-free and that its footprint stays zero.
**Fix**: Store the product→runtime pointer in a registry located under the coordination install root (e.g., `~/.local/share/coordination/registry.json`), keeping it strictly outside the product tree.
