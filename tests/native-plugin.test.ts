import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { readExecutionRecords } from "../src/execution/records.js";
import { cleanup, makeTmpDir } from "./helpers.js";

// The hook runtime is deliberately dependency-free JavaScript because Codex
// executes it before the TypeScript package needs to be loaded.
// @ts-expect-error runtime module is shipped as plain ESM
import {
  captureSession,
  changedFilesFromPatch,
  recordToolEvent,
  workspaceKey,
} from "../hooks/runtime.mjs";

describe("native Codex workspace plugin hooks", () => {
  const dirs: string[] = [];

  afterEach(() => {
    delete process.env.C2C_STATE_DIR;
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
  });

  it("uses the same stable workspace identity as the C2C read-only bridge", () => {
    const root = makeTmpDir("native-workspace");
    dirs.push(root);
    const workspace = new Workspace(root);
    expect(workspaceKey(root)).toBe(workspace.id);
  });

  it("binds a Codex session to cwd and exposes hook execution records through MCP storage", () => {
    const root = makeTmpDir("native-session");
    const state = makeTmpDir("native-state");
    dirs.push(root, state);
    process.env.C2C_STATE_DIR = state;

    const workspace = new Workspace(root);
    captureSession(
      {
        session_id: "thr_native_123",
        cwd: root,
        hook_event_name: "SessionStart",
        source: "startup",
        model: "gpt-5.6-sol",
        permission_mode: "default",
      },
      state
    );

    recordToolEvent(
      {
        session_id: "thr_native_123",
        turn_id: "turn_1",
        cwd: root,
        tool_name: "Bash",
        tool_use_id: "tool_1",
        tool_input: { command: "pnpm test" },
        tool_response: { exit_code: 0, output: "all good" },
      },
      state
    );

    recordToolEvent(
      {
        session_id: "thr_native_123",
        turn_id: "turn_1",
        cwd: root,
        tool_name: "apply_patch",
        tool_use_id: "tool_2",
        tool_input: {
          command: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch",
        },
        tool_response: { ok: true },
      },
      state
    );

    const sessionFile = path.join(state, "native", "sessions", "thr_native_123.json");
    expect(JSON.parse(fs.readFileSync(sessionFile, "utf8")).workspaceRoot).toBe(root);

    const records = readExecutionRecords(workspace.id, 10);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      source: "hook",
      kind: "test",
      exitStatus: "ok",
      sessionId: "thr_native_123",
    });
    expect(records[0].tests).toContain("test: ok");
    expect(records[1]).toMatchObject({
      source: "hook",
      kind: "edit",
      changedFiles: ["src/a.ts"],
    });
  });

  it("does not persist bearer secrets from Bash commands", () => {
    const root = makeTmpDir("native-redaction");
    const state = makeTmpDir("native-redaction-state");
    dirs.push(root, state);

    recordToolEvent(
      {
        session_id: "thr_secret",
        cwd: root,
        tool_name: "Bash",
        tool_use_id: "tool_secret",
        tool_input: { command: 'curl -H "Authorization: Bearer supersecret123456789" https://example.com' },
        tool_response: { exit_code: 0 },
      },
      state
    );

    const eventFile = path.join(state, "native", "events", workspaceKey(root) + ".jsonl");
    const saved = fs.readFileSync(eventFile, "utf8");
    expect(saved).not.toContain("supersecret123456789");
    expect(saved).toContain("[REDACTED]");
  });

  it("extracts changed files without storing patch bodies", () => {
    expect(
      changedFilesFromPatch(
        "*** Begin Patch\n*** Update File: src/a.ts\n*** Add File: src/b.ts\n*** Delete File: old.txt\n*** End Patch"
      )
    ).toEqual(["src/a.ts", "src/b.ts", "old.txt"]);
  });
});
