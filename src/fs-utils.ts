import fs from "node:fs";
import path from "node:path";

export class JsonParseError extends Error {
  readonly filePath: string;

  constructor(filePath: string, cause: unknown) {
    super(`malformed JSON: ${filePath}`);
    this.name = "JsonParseError";
    this.filePath = filePath;
    this.cause = cause;
  }
}

export function readJsonFile<T>(filePath: string): T | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  const raw = fs.readFileSync(filePath, "utf8");
  const trimmed = raw.replace(/^\uFEFF/, "").trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as T;
  } catch (cause) {
    throw new JsonParseError(filePath, cause);
  }
}

export function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function isDirectory(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function listDir(filePath: string): string[] {
  if (!isDirectory(filePath)) return [];
  return fs.readdirSync(filePath);
}

export function walkFiles(root: string, predicate: (filePath: string) => boolean): string[] {
  const out: string[] = [];
  if (!isDirectory(root)) return out;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const name of fs.readdirSync(current)) {
      const next = path.join(current, name);
      let stat;
      try {
        stat = fs.statSync(next);
      } catch {
        continue;
      }
      if (stat.isDirectory()) stack.push(next);
      else if (stat.isFile() && predicate(next)) out.push(next);
    }
  }
  return out;
}
