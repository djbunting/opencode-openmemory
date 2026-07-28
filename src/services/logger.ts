import { appendFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const LOG_FILE = join(homedir(), ".opencode-openmemory.log");

try {
  writeFileSync(LOG_FILE, `\n--- Session started: ${new Date().toISOString()} ---\n`, { flag: "a" });
} catch {
  // Non-writable home dir shouldn't prevent the plugin from loading.
}

export function log(message: string, data?: unknown) {
  const timestamp = new Date().toISOString();
  const line = data
    ? `[${timestamp}] ${message}: ${JSON.stringify(data)}\n`
    : `[${timestamp}] ${message}\n`;
  try {
    appendFileSync(LOG_FILE, line);
  } catch {
    // Best-effort logging only.
  }
}
