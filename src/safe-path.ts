import fs from "node:fs";
import path from "node:path";

/** Decides whether a discovered file may be read (used to enforce plugin-root containment). */
export type FileFilter = (filePath: string) => boolean;

export function isInside(inner: string, outer: string): boolean {
  const a = path.resolve(inner);
  const b = path.resolve(outer);
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

export function realpathOrUndefined(target: string): string | undefined {
  try {
    return fs.realpathSync(target);
  } catch {
    return undefined;
  }
}

export type Contained = { ok: true; path: string } | { ok: false; reason: string };

/**
 * Resolve `target` and require the result to stay inside `realBase` (an already
 * symlink-resolved directory), following symlinks the way Agent Plugins §4.1 asks.
 *
 * The check works for targets that do not exist yet: the nearest existing ancestor is
 * resolved through the filesystem and the missing tail is appended lexically. A symlink
 * that cannot be resolved (dangling, loop) is refused, because where it points is unknown.
 */
export function resolveWithin(realBase: string, target: string): Contained {
  const lexical = path.resolve(target);
  if (!isInside(lexical, realBase)) {
    return { ok: false, reason: `${target} resolves outside ${realBase}` };
  }
  let current = lexical;
  const tail: string[] = [];
  for (;;) {
    let real: string | undefined;
    try {
      real = fs.realpathSync(current);
    } catch {
      let isLink = false;
      try {
        isLink = fs.lstatSync(current).isSymbolicLink();
      } catch {
        // missing component: look one level up
      }
      if (isLink) return { ok: false, reason: `${target} is a symlink that cannot be resolved` };
    }
    if (real !== undefined) {
      const resolved = tail.length ? path.join(real, ...tail) : real;
      if (!isInside(resolved, realBase)) {
        return { ok: false, reason: `${target} resolves outside ${realBase} (to ${resolved})` };
      }
      return { ok: true, path: lexical };
    }
    const parent = path.dirname(current);
    if (parent === current) return { ok: false, reason: `${target} cannot be resolved` };
    tail.unshift(path.basename(current));
    current = parent;
  }
}

export type FileKind = "file" | "directory" | "other" | "missing";

/** Kind of the thing `target` resolves to, following symlinks. A missing or dangling path is `missing`. */
export function kindOf(target: string): FileKind {
  try {
    const stat = fs.statSync(target);
    if (stat.isFile()) return "file";
    if (stat.isDirectory()) return "directory";
    return "other";
  } catch {
    return "missing";
  }
}

/** True when something (including a dangling symlink) exists at `target` without following links. */
export function existsNoFollow(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}
