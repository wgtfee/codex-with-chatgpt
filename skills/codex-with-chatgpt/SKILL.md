---
name: codex-with-chatgpt-native
description: >
  Use ChatGPT as a planning/review layer for the current Codex workspace.
  Use when the user asks for Codex with ChatGPT, C2C setup, ChatGPT planning,
  or review of work in the active Codex project.
---

# Codex with ChatGPT — native workspace mode

The Codex session owns workspace identity and execution. C2C must not create a
second workspace-selection layer.

## Native workspace rules

1. The authoritative workspace is the current Codex `cwd` supplied by the
   SessionStart hook. Never guess it and never ask the user for a path.
2. SessionStart supplies an exact C2C command prefix containing the installed
   plugin path and plugin data directory. Reuse that prefix verbatim.
3. Run C2C commands from the current Codex cwd. Do not pass `-w` or
   `--workspace`.
4. Bash and `apply_patch` metadata are captured automatically by PostToolUse.
   Do not call `c2c record` merely to report changed files or a test/build
   command. Use explicit `c2c record` only when you intentionally need to
   release a sanitized output body that hooks do not store.
5. The plugin data directory is the C2C state directory. Do not modify
   `~/.codex/config.toml` just to make C2C state writable.
6. The existing Bridge remains a thin, read-only data出口 for ChatGPT Web. It
   does not own workspace discovery.

## First connection

Use the exact C2C command prefix from SessionStart.

1. Run `<c2c> tunnel status --json`. If a connection choice is required,
   follow the returned prompt, then choose quick or named with the same prefix.
2. Run `<c2c> setup --json`. The cwd is already the workspace.
3. Configure the returned `connectorName` and `mcpUrl` in ChatGPT.
   If browser automation is unavailable or the in-app browser cannot log in,
   use the user's normal signed-in browser. Never copy cookies, tokens, local
   storage, or browser profile files.
4. Generate a fresh pairing code only when the OAuth pairing form is visible:
   `<c2c> pair --json`.
5. Verify from ChatGPT that the exact connector can call `workspace_info` and
   that the returned workspace name matches the current Codex cwd.

## Coding loop

- ChatGPT plans and reviews; Codex edits, runs commands, tests, and commits.
- When ChatGPT needs code or git facts, it reads them through the C2C connector.
- Hook-generated execution records are visible through `execution_summary`
  and `test_status`; current code/diffs remain the source of truth.
- Keep control messages small. Never paste file bodies, diffs, or raw logs into
  ChatGPT when the connector can read them.
- If the public connector address changes, repair only the connector endpoint.
  Do not change the Codex workspace binding: cwd/session identity is native.

## Recovery

Run `<c2c> doctor --json` from the current cwd. A browser-side or connector
failure is not permission to select a different workspace or create another
workspace record.
