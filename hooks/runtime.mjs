import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const MAX_COMMAND = 600;
const MAX_NOTE = 800;

export async function readStdinJson(stream = process.stdin) {
  let body = "";
  for await (const chunk of stream) body += chunk;
  if (!body.trim()) return {};
  return JSON.parse(body);
}

export function pluginDataDir(env = process.env) {
  const value = env.PLUGIN_DATA || env.CLAUDE_PLUGIN_DATA || env.C2C_PLUGIN_DATA;
  if (!value) throw new Error("PLUGIN_DATA is required for the native workspace plugin");
  return path.resolve(value);
}

export function canonicalWorkspaceRoot(cwd) {
  const resolved = path.resolve(cwd || process.cwd());
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function normCase(value) {
  return process.platform === "win32" || process.platform === "darwin" ? value.toLowerCase() : value;
}

export function workspaceKey(cwd) {
  return crypto.createHash("sha256").update(normCase(canonicalWorkspaceRoot(cwd))).digest("hex").slice(0, 12);
}

function safeId(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function atomicWriteJson(file, data) {
  ensureDir(path.dirname(file));
  const tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

function appendJsonLine(file, data) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(data) + "\n", { mode: 0o600 });
}

export function nativePaths(dataDir, cwd, sessionId) {
  const key = workspaceKey(cwd);
  return {
    workspaceKey: key,
    workspace: path.join(dataDir, "native", "workspaces", key + ".json"),
    session: path.join(dataDir, "native", "sessions", safeId(sessionId) + ".json"),
    events: path.join(dataDir, "native", "events", key + ".jsonl")
  };
}

function nowIso() {
  return new Date().toISOString();
}

export function captureSession(event, dataDir) {
  const root = canonicalWorkspaceRoot(event.cwd);
  const paths = nativePaths(dataDir, root, event.session_id);
  const now = nowIso();
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(paths.session, "utf8")); } catch {}
  const session = {
    schemaVersion: 1,
    sessionId: String(event.session_id || ""),
    workspaceKey: paths.workspaceKey,
    workspaceRoot: root,
    workspaceName: path.basename(root),
    source: event.source ?? previous?.source ?? null,
    model: event.model ?? previous?.model ?? null,
    permissionMode: event.permission_mode ?? previous?.permissionMode ?? null,
    transcriptPath: event.transcript_path ?? previous?.transcriptPath ?? null,
    startedAt: previous?.startedAt || now,
    lastSeenAt: now
  };
  const workspace = {
    schemaVersion: 1,
    workspaceKey: paths.workspaceKey,
    root,
    name: path.basename(root),
    lastSessionId: session.sessionId,
    lastSeenAt: now
  };
  atomicWriteJson(paths.workspace, workspace);
  atomicWriteJson(paths.session, session);
  return { session, workspace, paths };
}

function redact(text) {
  return String(text)
    .replace(/(authorization\s*:\s*bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/(bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi, "$1[REDACTED]")
    .replace(/([?&](?:token|access_token|refresh_token|api_key|key)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/\b[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}\b/g, "[PAIRING_CODE]");
}

export function changedFilesFromPatch(command) {
  const files = [];
  for (const line of String(command || "").split(/\r?\n/)) {
    const match = line.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/);
    if (match) files.push(match[1].trim());
  }
  return [...new Set(files)].slice(0, 100);
}

function commandSummary(toolName, toolInput) {
  const raw = typeof toolInput?.command === "string" ? toolInput.command : "";
  if (toolName === "apply_patch") {
    const files = changedFilesFromPatch(raw);
    return files.length ? ("apply_patch: " + files.join(", ")).slice(0, MAX_COMMAND) : "apply_patch";
  }
  return redact(raw.replace(/\s+/g, " ").trim()).slice(0, MAX_COMMAND);
}

function findExitCode(value, depth = 0) {
  if (depth > 4 || value == null) return null;
  if (typeof value === "object") {
    for (const key of ["exit_code", "exitCode", "code", "status"]) {
      const candidate = value[key];
      if (typeof candidate === "number" && Number.isInteger(candidate)) return candidate;
    }
    for (const candidate of Object.values(value)) {
      const nested = findExitCode(candidate, depth + 1);
      if (nested !== null) return nested;
    }
  }
  return null;
}

export function classifyCommand(command) {
  const value = String(command || "").toLowerCase();
  if (/\b(vitest|jest|pytest|dotnet\s+test|cargo\s+test|go\s+test|pnpm\s+(?:run\s+)?test|npm\s+(?:run\s+)?test|yarn\s+(?:run\s+)?test)\b/.test(value)) return "test";
  if (/\b(tsc|typecheck|mypy|pyright)\b/.test(value)) return "typecheck";
  if (/\b(eslint|biome|ruff|lint)\b/.test(value)) return "lint";
  if (/\b(pnpm|npm|yarn|bun|cargo|dotnet|go)\s+(?:run\s+)?build\b|\bwebpack\b|\bvite\s+build\b/.test(value)) return "build";
  return "command";
}

export function recordToolEvent(event, dataDir) {
  const root = canonicalWorkspaceRoot(event.cwd);
  const { session } = captureSession({ ...event, source: undefined }, dataDir);
  const paths = nativePaths(dataDir, root, event.session_id);
  const toolName = String(event.tool_name || "unknown");
  const rawCommand = typeof event.tool_input?.command === "string" ? event.tool_input.command : "";
  const exitCode = findExitCode(event.tool_response);
  const changedFiles = toolName === "apply_patch" ? changedFilesFromPatch(rawCommand) : [];
  const kind = toolName === "apply_patch" ? "edit" : classifyCommand(rawCommand);
  const record = {
    schemaVersion: 1,
    source: "codex-hook",
    sessionId: session.sessionId,
    turnId: event.turn_id || null,
    toolUseId: event.tool_use_id || null,
    workspaceKey: paths.workspaceKey,
    toolName,
    kind,
    command: commandSummary(toolName, event.tool_input),
    changedFiles,
    exitCode,
    exitStatus: exitCode === null ? "unknown" : exitCode === 0 ? "ok" : "failed",
    responseBytes: Buffer.byteLength(JSON.stringify(event.tool_response ?? null), "utf8"),
    timestamp: nowIso()
  };
  appendJsonLine(paths.events, record);
  return record;
}

export function endSession(event, dataDir) {
  const paths = nativePaths(dataDir, event.cwd, event.session_id);
  let session = null;
  try { session = JSON.parse(fs.readFileSync(paths.session, "utf8")); } catch {}
  if (!session) return null;
  session.lastSeenAt = nowIso();
  session.endedAt = session.lastSeenAt;
  session.endReason = event.reason || null;
  atomicWriteJson(paths.session, session);
  return session;
}

export function tryAutostartBridge(event, env = process.env) {
  if (env.C2C_NATIVE_AUTOSTART === "0") return { attempted: false, reason: "disabled" };
  if (event.source === "compact") return { attempted: false, reason: "compact" };
  const pluginRoot = env.PLUGIN_ROOT || env.CLAUDE_PLUGIN_ROOT;
  const dataDir = pluginDataDir(env);
  if (!pluginRoot) return { attempted: false, reason: "missing-plugin-root" };
  const dist = path.join(pluginRoot, "dist", "cli", "index.js");
  if (!fs.existsSync(dist)) return { attempted: false, reason: "dist-missing" };
  const cli = path.join(pluginRoot, "bin", "c2c.js");
  const result = spawnSync(process.execPath, [cli, "start", "--json"], {
    cwd: canonicalWorkspaceRoot(event.cwd),
    env: { ...env, C2C_STATE_DIR: dataDir, C2C_PLUGIN_MODE: "1" },
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true
  });
  return {
    attempted: true,
    ok: result.status === 0,
    status: result.status,
    stderr: redact(result.stderr || "").slice(0, MAX_NOTE)
  };
}

export function buildSessionContext(event, dataDir, autostart) {
  const root = canonicalWorkspaceRoot(event.cwd);
  const pluginRoot = process.env.PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT || "<plugin-root>";
  const cli = 'node "' + path.join(pluginRoot, "scripts", "c2c-native.mjs") + '" --state-dir "' + dataDir + '"';
  const startState = autostart?.attempted ? (autostart.ok ? "local bridge is ready" : "local bridge autostart failed") : "local bridge autostart was skipped";
  return [
    "Codex with ChatGPT native-workspace plugin is active.",
    "Authoritative workspace: " + root,
    "Codex session: " + (event.session_id || "unknown"),
    "Do not rediscover, guess, or ask for the workspace path. The Codex cwd above is the workspace boundary.",
    "Use this exact C2C command prefix when C2C management is needed: " + cli,
    "Run it from the current Codex cwd and omit -w/--workspace.",
    "Bash and apply_patch metadata are recorded automatically by PostToolUse hooks; do not run c2c record only for bookkeeping.",
    "Startup state: " + startState + "."
  ].join("\n");
}
