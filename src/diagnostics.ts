import { debug, warn } from "./log.js";

/**
 * Problems found while loading one plugin. Each message is logged (as a warning, or at debug
 * level for plugins that are switched off) and kept so `list` can show it.
 */
export class Diagnostics {
  readonly messages: string[] = [];

  constructor(
    private readonly subject: string,
    private readonly loud: boolean = true,
  ) {}

  warn(message: string): void {
    this.messages.push(message);
    const line = `plugin "${this.subject}": ${message}`;
    if (this.loud) warn(line);
    else debug(line);
  }
}
