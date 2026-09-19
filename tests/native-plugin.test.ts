import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
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

    recordToolEvent(
      {
        session_id: "thr_secret",
        cwd: root,
        tool_name: "Bash",
        tool_use_id: "tool_secret_2",
        tool_input: { command: "OPENAI_API_KEY=sk-supersecret987654321 node app.js --token anotherSecret123456" },
        tool_response: { exit_code: 0 },
      },
      state
    );
    const savedAgain = fs.readFileSync(eventFile, "utf8");
    expect(savedAgain).not.toContain("sk-supersecret987654321");
    expect(savedAgain).not.toContain("anotherSecret123456");
  });


  it("uses a cross-platform wrapper and keeps sandbox configuration untouched in plugin mode", () => {
    const state = makeTmpDir("native-wrapper-state");
    dirs.push(state);

    const result = spawnSync(
      process.execPath,
      [
        path.join(process.cwd(), "scripts", "c2c-native.mjs"),
        "--state-dir",
        state,
        "sandbox-allow",
        "--json",
      ],
      { cwd: process.cwd(), encoding: "utf8" }
    );

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload).toMatchObject({
      ok: true,
      added: false,
      alreadyAllowed: true,
      configPath: "PLUGIN_DATA",
    });
    expect(payload.stateDir).toBe(path.resolve(state));
  });

  it("ships valid plugin manifests whose hook and skill paths exist", () => {
    const root = process.cwd();
    const portable = JSON.parse(fs.readFileSync(path.join(root, "plugin.json"), "utf8"));
    const compat = JSON.parse(fs.readFileSync(path.join(root, ".codex-plugin", "plugin.json"), "utf8"));
    const hooks = JSON.parse(fs.readFileSync(path.join(root, "hooks", "hooks.json"), "utf8"));
    const marketplace = JSON.parse(
      fs.readFileSync(path.join(root, ".agents", "plugins", "marketplace.json"), "utf8")
    );

    expect(portable.name).toBe("codex-with-chatgpt");
    expect(portable.skills).toBe("./skills/");
    expect(portable.extensions?.["com.openai"]?.hooks).toBe("./hooks/hooks.json");
    expect(compat.hooks).toBe("./hooks/hooks.json");
    expect(fs.existsSync(path.join(root, "skills", "codex-with-chatgpt", "SKILL.md"))).toBe(true);
    expect(hooks.hooks.SessionStart[0].hooks[0].command).toContain("${PLUGIN_ROOT}");
    expect(fs.existsSync(path.join(root, "hooks", "session-start.mjs"))).toBe(true);
    expect(fs.existsSync(path.join(root, "hooks", "post-tool-use.mjs"))).toBe(true);
    expect(marketplace.plugins[0]).toMatchObject({
      name: "codex-with-chatgpt",
      source: { source: "local", path: "./" },
    });
  });

  it("runs the Codex lifecycle end-to-end against the current cwd", () => {
    const root = makeTmpDir("native-e2e-workspace");
    const state = makeTmpDir("native-e2e-state");
    dirs.push(root, state);
    const pluginRoot = process.cwd();
    const wrapper = path.join(pluginRoot, "scripts", "c2c-native.mjs");
    const hookEnv = {
      ...process.env,
      PLUGIN_ROOT: pluginRoot,
      PLUGIN_DATA: state,
    };

    try {
      const started = spawnSync(process.execPath, [path.join(pluginRoot, "hooks", "session-start.mjs")], {
        cwd: root,
        env: hookEnv,
        input: JSON.stringify({
          session_id: "thr_e2e_native",
          cwd: root,
          hook_event_name: "SessionStart",
          source: "startup",
          model: "gpt-5.6-sol",
          permission_mode: "default",
        }),
        encoding: "utf8",
        timeout: 20_000,
      });
      expect(started.status).toBe(0);
      const hookOutput = JSON.parse(started.stdout.trim());
      expect(hookOutput.hookSpecificOutput.additionalContext).toContain("Authoritative workspace: " + root);
      expect(hookOutput.hookSpecificOutput.additionalContext).toContain("local bridge is ready");

      const status = spawnSync(
        process.execPath,
        [wrapper, "--state-dir", state, "status", "--json"],
        { cwd: root, encoding: "utf8", timeout: 15_000 }
      );
      expect(status.status).toBe(0);
      expect(JSON.parse(status.stdout.trim())).toMatchObject({
        ok: true,
        running: true,
        workspaceRoot: root,
      });

      const posted = spawnSync(process.execPath, [path.join(pluginRoot, "hooks", "post-tool-use.mjs")], {
        cwd: root,
        env: hookEnv,
        input: JSON.stringify({
          session_id: "thr_e2e_native",
          turn_id: "turn_e2e",
          cwd: root,
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_use_id: "tool_e2e",
          tool_input: { command: "pnpm test" },
          tool_response: { exit_code: 0 },
        }),
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(posted.status).toBe(0);

      process.env.C2C_STATE_DIR = state;
      const workspace = new Workspace(root);
      expect(readExecutionRecords(workspace.id, 5).at(-1)).toMatchObject({
        source: "hook",
        kind: "test",
        exitStatus: "ok",
        sessionId: "thr_e2e_native",
      });
    } finally {
      spawnSync(process.execPath, [wrapper, "--state-dir", state, "stop"], {
        cwd: root,
        encoding: "utf8",
        timeout: 15_000,
      });
    }
  });

  it("extracts changed files without storing patch bodies", () => {
    expect(
      changedFilesFromPatch(
        "*** Begin Patch\n*** Update File: src/a.ts\n*** Add File: src/b.ts\n*** Delete File: old.txt\n*** Update File: .env\n*** Add File: secrets.json\n*** End Patch"
      )
    ).toEqual(["src/a.ts", "src/b.ts", "old.txt"]);
  });
});
