export type PluginOptions = {
  skipInstalled?: boolean;
  extraPluginDirs?: Record<string, string>;
  mcpDisabled?: boolean;
  instructions?: boolean;
};

export function parsePluginOptions(raw: unknown): PluginOptions {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const rec = raw as Record<string, unknown>;
  const extraPluginDirs =
    rec.extraPluginDirs && typeof rec.extraPluginDirs === "object" && !Array.isArray(rec.extraPluginDirs)
      ? Object.fromEntries(
          Object.entries(rec.extraPluginDirs as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : undefined;
  return {
    skipInstalled: rec.skipInstalled === true,
    extraPluginDirs,
    mcpDisabled: rec.mcpDisabled === true,
    instructions: rec.instructions === false ? false : true,
  };
}
