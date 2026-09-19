import { endSession, pluginDataDir, readStdinJson } from "./runtime.mjs";

try {
  const event = await readStdinJson();
  endSession(event, pluginDataDir());
} catch {
  // Session cleanup is advisory.
}
