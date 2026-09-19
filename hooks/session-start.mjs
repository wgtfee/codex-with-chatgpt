import { buildSessionContext, captureSession, pluginDataDir, readStdinJson, tryAutostartBridge } from "./runtime.mjs";

try {
  const event = await readStdinJson();
  const dataDir = pluginDataDir();
  captureSession(event, dataDir);
  const autostart = tryAutostartBridge(event);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: buildSessionContext(event, dataDir, autostart)
    }
  }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    systemMessage: "Codex with ChatGPT plugin could not initialize native workspace state: " +
      (error instanceof Error ? error.message : String(error))
  }));
}
