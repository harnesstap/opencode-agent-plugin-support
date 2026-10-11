import { DEBUG_ENV, PLUGIN_ID } from "./identity.js";

export function warn(message: string, extra?: unknown): void {
  if (extra === undefined) {
    console.warn(`[${PLUGIN_ID}] ${message}`);
    return;
  }
  console.warn(`[${PLUGIN_ID}] ${message}`, extra);
}

export function error(message: string, extra?: unknown): void {
  if (extra === undefined) {
    console.error(`[${PLUGIN_ID}] ${message}`);
    return;
  }
  console.error(`[${PLUGIN_ID}] ${message}`, extra);
}

export function debugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[DEBUG_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

/** Written to stderr so `list` JSON on stdout stays machine-readable. */
export function debug(message: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!debugEnabled(env)) return;
  console.error(`[${PLUGIN_ID}] debug: ${message}`);
}
