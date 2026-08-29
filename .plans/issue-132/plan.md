# Issue 132: Default terminal profiles for onboard/install

## Goal

Change default macOS Terminal.app profile names written into workspace config by
`coord onboard` / `coord install`.

| Agent | Old default | New default |
| --- | --- | --- |
| claude | Pro | Claude 1 |
| codex | Grass | Codex 1 |
| cursor | Ocean | Cursor 1 |
| antigravity | Red Sands | Gemini 1 |

Nudge prelude/submit keys are unchanged.

## Files

- `src/setupWorkspace.ts` — `agentOwnerUiDefaults()`
- `docs/coord-driver.md` — document new defaults
- `test/install.test.ts` — assert profiles on a four-agent install

## Out of scope

- Migrating existing `config.json` files (re-run install/onboard to adopt)
- Changing `harnessProcess` or nudge key behavior
