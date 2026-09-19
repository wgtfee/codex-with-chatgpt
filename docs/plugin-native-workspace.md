# Codex native workspace plugin

This branch moves workspace/session ownership from the C2C Skill into Codex's
plugin lifecycle.

## What is native now

- **Workspace root:** the Codex hook input `cwd` is authoritative.
- **Session identity:** the hook input `session_id` binds activity to the Codex
  conversation.
- **Execution metadata:** `PostToolUse` records Bash and `apply_patch`
  metadata automatically.
- **Writable state:** plugin lifecycle data lives under `PLUGIN_DATA`.
- **Bridge startup:** SessionStart reuses/starts the local read-only bridge when
  a built `dist/` is present, with `C2C_STATE_DIR=PLUGIN_DATA`.

The workspace hash intentionally matches the existing `Workspace.id`, so the
read-only MCP server can consume hook records without a migration table.

## What remains in C2C

The bridge still enforces path containment, sensitive-file policy and read-only
MCP tools because ChatGPT Web cannot directly read the local Codex filesystem.
Tunnel/OAuth/pairing also remain only at that remote boundary.

## State layout

```
PLUGIN_DATA/
  native/
    workspaces/<workspace-id>.json
    sessions/<codex-session-id>.json
    events/<workspace-id>.jsonl
  executions/
  sessions/
  ...
```

Raw tool output is not stored by the hook. Command summaries are bounded and
credential-like values are redacted. Existing `c2c record` remains available
only when Codex intentionally releases a sanitized test/build output body.

## Local plugin test

Build first so SessionStart can autostart the bridge:

```bash
corepack pnpm install
corepack pnpm build
corepack pnpm test
```

Install this repository as a local Codex plugin/marketplace source, review and
trust its hooks, then open any repository in a new Codex session. The
SessionStart context should report that repository's cwd as the authoritative
workspace; no `-w` argument is required.
