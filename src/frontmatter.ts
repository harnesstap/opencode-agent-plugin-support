import YAML from "yaml";

export type FrontmatterResult<T extends Record<string, unknown> = Record<string, unknown>> = {
  data: T;
  body: string;
};

export function parseFrontmatter<T extends Record<string, unknown> = Record<string, unknown>>(
  source: string,
): FrontmatterResult<T> {
  const text = source.replace(/^\uFEFF/, "");
  if (!text.startsWith("---")) {
    return { data: {} as T, body: text };
  }
  const rest = text.slice(3);
  const newline = rest.startsWith("\r\n") ? 2 : rest.startsWith("\n") ? 1 : 0;
  if (!newline) return { data: {} as T, body: text };
  const bodyStart = rest.slice(newline);
  const endMatch = bodyStart.match(/\r?\n---[ \t]*\r?\n/);
  if (!endMatch || endMatch.index === undefined) {
    const eof = bodyStart.match(/\r?\n---[ \t]*$/);
    if (!eof || eof.index === undefined) return { data: {} as T, body: text };
    const yamlText = bodyStart.slice(0, eof.index);
    return { data: parseYamlObject<T>(yamlText), body: "" };
  }
  const yamlText = bodyStart.slice(0, endMatch.index);
  const body = bodyStart.slice(endMatch.index + endMatch[0].length);
  return { data: parseYamlObject<T>(yamlText), body };
}

function parseYamlObject<T extends Record<string, unknown>>(yamlText: string): T {
  const parsed = YAML.parse(yamlText) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {} as T;
  return parsed as T;
}

export function splitList(value: unknown): string[] {
  if (value === undefined || value === null || value === "") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => splitList(item));
  }
  if (typeof value === "string") {
    return value
      .split(/[,|\n]/)
      .map((part) => part.trim())
      .filter(Boolean);
  }
  return [String(value)];
}
