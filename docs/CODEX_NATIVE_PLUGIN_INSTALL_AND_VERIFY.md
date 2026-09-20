# Codex native plugin: packaged install and real-client verification

This document is the final-user validation path for the native workspace plugin. It intentionally uses the compiled GitHub Actions artifact rather than a source checkout.

## Download the compiled package

Open the latest successful **Native plugin CI** run for `feature/codex-native-workspace-plugin` and download the `codex-with-chatgpt-native-plugin` artifact. Extract it to a stable local directory.

The package is expected to contain at least:

- `.codex-plugin/plugin.json`
- `plugin.json`
- `hooks/hooks.json`
- `dist/cli/index.js`
- `bin/c2c.js`
- `scripts/`
- `skills/`
- production `node_modules/`

No `pnpm install` or `pnpm build` should be required on the target machine. Node.js is still required because the plugin hooks and Bridge are Node processes.

## Install in a real Codex client

Use the Codex client's native plugin/marketplace UI or CLI to add the extracted package as a local plugin source, then install **Codex with ChatGPT** and explicitly review/trust its hooks.

Codex plugin CLI syntax can change between client versions, so use `codex plugin --help` on the target client as the authoritative command reference instead of copying an unverified command from this document.

After installation, close the source/package directory. The validation must be performed from a separate, real project.

## Real-project smoke test

1. Open a real project directory in Codex and start a fresh conversation.
2. Confirm the SessionStart context reports that project's current working directory as `Authoritative workspace`.
3. Confirm no manual `-w`/`--workspace` argument was needed.
4. Confirm plugin state contains a session record whose `sessionId` matches the Codex `session_id` and whose `workspaceRoot` is the project directory.
5. Confirm SessionStart starts the local Bridge, or reuses the already-running Bridge for that workspace.
6. Run a harmless shell command through Codex and confirm PostToolUse appends an execution event for the same workspace/session.
7. Perform a harmless repository edit through the normal Codex edit path and confirm the recorded event contains sanitized edit metadata.
8. End/reopen the Codex session and verify lifecycle state remains consistent.

Do not mark the native-plugin work complete until this test has been executed in an actual Codex client. CI simulation and packaged-CLI smoke tests do not satisfy this gate.

## Expected automatic behavior

- `workspace = Codex cwd`; Codex owns workspace identity.
- `session_id` comes from the Codex hook event.
- PostToolUse records execution metadata automatically.
- Bridge startup/reuse is scoped to the active workspace and uses plugin data for state.
- ChatGPT-facing MCP remains read-only.

## Known limitations

- A real Codex client is required for the final install and lifecycle smoke test; GitHub Actions cannot prove client installation, hook trust prompts, or real project binding.
- The packaged plugin still requires a compatible Node.js runtime.
- Plugin installation commands/UI are Codex-client-version dependent; check `codex plugin --help` on the target client.
- Hooks record bounded/sanitized metadata rather than raw command output. Sensitive paths and credential-like values are intentionally suppressed/redacted.
- The Bridge is still required when ChatGPT Web needs read-only access to local workspace state; the plugin removes workspace discovery from the Bridge but does not remove that remote boundary.

## Completion evidence to retain

Record the Codex client version, installation result, tested project path, observed authoritative workspace, session id, Bridge start/reuse result, one PostToolUse execution record, and any client-specific limitation. These are the evidence for completion gates 4-6.
