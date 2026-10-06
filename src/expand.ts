const VAR = /\$\{([A-Za-z_][A-Za-z0-9_.]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

export type ExpandContext = {
  pluginRoot: string;
  pluginData: string;
  projectDir: string;
  env: NodeJS.ProcessEnv;
  userConfig?: Record<string, string | number | boolean | undefined>;
};

export function expandString(value: string, ctx: ExpandContext): string {
  return value.replace(VAR, (full, braced?: string, bare?: string) => {
    const name = braced ?? bare ?? "";
    if (name === "CLAUDE_PLUGIN_ROOT") return ctx.pluginRoot;
    if (name === "CLAUDE_PLUGIN_DATA") return ctx.pluginData;
    if (name === "CLAUDE_PROJECT_DIR") return ctx.projectDir;
    if (name.startsWith("user_config.")) {
      const key = name.slice("user_config.".length);
      const found = ctx.userConfig?.[key];
      return found === undefined || found === null ? "" : String(found);
    }
    const fromEnv = ctx.env[name];
    if (fromEnv !== undefined) return fromEnv;
    return full;
  });
}

export function expandDeep<T>(value: T, ctx: ExpandContext): T {
  if (typeof value === "string") return expandString(value, ctx) as T;
  if (Array.isArray(value)) return value.map((item) => expandDeep(item, ctx)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = expandDeep(nested, ctx);
    }
    return out as T;
  }
  return value;
}
