import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ensureDir, getStateDir } from "../config/paths.js";

/**
 * Execution records can come from either the legacy explicit `c2c record`
 * command or Codex's native PostToolUse hook. The latter lets the plugin use
 * Codex's own workspace/session lifecycle instead of making the Skill maintain
 * a second execution ledger.
 */
export const executionRecordSchema = z.object({
  taskId: z.string(),
  iteration: z.number().int().nonnegative(),
  changedFiles: z.union([z.array(z.string()), z.number().int().nonnegative()]),
  tests: z.string().nullable(),
  exitStatus: z.string(),
  timestamp: z.string(),
  notes: z.string().optional(),
  outputId: z.number().int().positive().optional(),
  outputAvailable: z.boolean().optional(),
  source: z.enum(["manual", "hook"]).optional(),
  sessionId: z.string().optional(),
  turnId: z.string().nullable().optional(),
  toolName: z.string().optional(),
  kind: z.enum(["command", "edit", "test", "build", "lint", "typecheck"]).optional(),
  command: z.string().optional(),
  exitCode: z.number().int().nullable().optional(),
});

export type ExecutionRecord = z.infer<typeof executionRecordSchema>;

const nativeToolEventSchema = z.object({
  source: z.literal("codex-hook"),
  sessionId: z.string(),
  turnId: z.string().nullable().optional(),
  toolName: z.string(),
  kind: z.enum(["command", "edit", "test", "build", "lint", "typecheck"]),
  command: z.string().default(""),
  changedFiles: z.array(z.string()).default([]),
  exitCode: z.number().int().nullable().default(null),
  exitStatus: z.string(),
  timestamp: z.string(),
});

function recordsFile(workspaceId: string): string {
  const dir = ensureDir(path.join(getStateDir(), "executions"));
  return path.join(dir, `${workspaceId}.jsonl`);
}

function nativeEventsFile(workspaceId: string): string {
  return path.join(getStateDir(), "native", "events", `${workspaceId}.jsonl`);
}

export function appendExecutionRecord(workspaceId: string, record: ExecutionRecord): void {
  const file = recordsFile(workspaceId);
  const parsed = executionRecordSchema.parse({ source: "manual", ...record });
  fs.appendFileSync(file, JSON.stringify(parsed) + "\n", { mode: 0o600 });
}

function readManualExecutionRecords(workspaceId: string): ExecutionRecord[] {
  const file = recordsFile(workspaceId);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  const records: ExecutionRecord[] = [];
  for (const line of lines) {
    try {
      const record = executionRecordSchema.safeParse(JSON.parse(line));
      if (record.success) records.push({ source: record.data.source ?? "manual", ...record.data });
    } catch {
      // skip corrupt lines
    }
  }
  return records;
}

function readNativeExecutionRecords(workspaceId: string): ExecutionRecord[] {
  const file = nativeEventsFile(workspaceId);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  const records: ExecutionRecord[] = [];
  for (let index = 0; index < lines.length; index++) {
    try {
      const parsed = nativeToolEventSchema.safeParse(JSON.parse(lines[index]));
      if (!parsed.success) continue;
      const event = parsed.data;
      const verification =
        event.kind === "test" || event.kind === "build" || event.kind === "lint" || event.kind === "typecheck";
      records.push({
        taskId: `codex_${event.sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(-12) || "session"}`,
        iteration: index + 1,
        changedFiles: event.changedFiles,
        tests: verification
          ? `${event.kind}: ${event.exitStatus}${event.command ? ` — ${event.command}` : ""}`
          : null,
        exitStatus: event.exitStatus,
        timestamp: event.timestamp,
        notes: event.command ? `${event.toolName}: ${event.command}` : event.toolName,
        source: "hook",
        sessionId: event.sessionId,
        turnId: event.turnId ?? null,
        toolName: event.toolName,
        kind: event.kind,
        command: event.command,
        exitCode: event.exitCode,
        outputAvailable: false,
      });
    } catch {
      // skip corrupt lines
    }
  }
  return records;
}

export function readExecutionRecords(workspaceId: string, limit = 10): ExecutionRecord[] {
  const requestedLimit = Math.max(1, Math.floor(limit));
  return [...readManualExecutionRecords(workspaceId), ...readNativeExecutionRecords(workspaceId)]
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .slice(-requestedLimit);
}

export function latestExecutionRecord(workspaceId: string): ExecutionRecord | null {
  const records = readExecutionRecords(workspaceId, 1);
  return records[records.length - 1] ?? null;
}
