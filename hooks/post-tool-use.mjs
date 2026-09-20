import { pluginDataDir, readStdinJson, recordToolEvent } from "./runtime.mjs";

try {
  const event = await readStdinJson();
  recordToolEvent(event, pluginDataDir());
} catch {
  // Recording is advisory and must never break a tool call.
}
