import { PLUGIN_ID } from "./identity.js";

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
