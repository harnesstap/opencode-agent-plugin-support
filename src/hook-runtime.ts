import { spawnSync } from "node:child_process";
import type { ClaudeHookGroup, ClaudeHookHandler } from "./hooks.js";
import { matcherHits } from "./tool-names.js";

export type HookStdinPayload = Record<string, unknown>;

export type HookRunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  json?: HookJsonOutput;
  blocked: boolean;
  blockReason?: string;
  additionalContext?: string;
  updatedInput?: Record<string, unknown>;
  permissionDecision?: "allow" | "deny" | "ask";
  continue?: boolean;
  systemMessage?: string;
  timedOut: boolean;
};

export type HookJsonOutput = {
  continue?: boolean;
  decision?: string;
  reason?: string;
  systemMessage?: string;
  hookSpecificOutput?: {
    hookEventName?: string;
    permissionDecision?: string;
    permissionDecisionReason?: string;
    additionalContext?: string;
    updatedInput?: Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export function parseHookStdout(stdout: string): HookJsonOutput | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as HookJsonOutput;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as HookJsonOutput;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

export function interpretHookResult(exitCode: number, stdout: string, stderr: string): HookRunResult {
  const json = parseHookStdout(stdout);
  const specific = json?.hookSpecificOutput;
  const permissionRaw = specific?.permissionDecision ?? json?.decision;
  const permissionDecision =
    permissionRaw === "allow" || permissionRaw === "approve"
      ? "allow"
      : permissionRaw === "deny" || permissionRaw === "block"
        ? "deny"
        : permissionRaw === "ask"
          ? "ask"
          : undefined;
  const additionalContext =
    typeof specific?.additionalContext === "string"
      ? specific.additionalContext
      : typeof json?.additionalContext === "string"
        ? json.additionalContext
        : undefined;
  const updatedInput =
    specific?.updatedInput && typeof specific.updatedInput === "object"
      ? specific.updatedInput
      : undefined;
  const continueFlag = json?.continue;
  const exitBlocks = exitCode === 2;
  const jsonBlocks = permissionDecision === "deny" || json?.decision === "block";
  const continueBlocks = continueFlag === false;
  const blocked = exitBlocks || jsonBlocks || continueBlocks;
  const blockReason =
    specific?.permissionDecisionReason ??
    (typeof json?.reason === "string" ? json.reason : undefined) ??
    (stderr.trim() || undefined) ??
    (exitBlocks ? stdout.trim() || "hook exited with code 2" : undefined);

  return {
    exitCode,
    stdout,
    stderr,
    json,
    blocked,
    blockReason,
    additionalContext,
    updatedInput,
    permissionDecision,
    continue: continueFlag,
    systemMessage: typeof json?.systemMessage === "string" ? json.systemMessage : undefined,
    timedOut: false,
  };
}

export function matchingHandlers(
  groups: ClaudeHookGroup[] | undefined,
  claudeToolName?: string,
): ClaudeHookHandler[] {
  if (!groups) return [];
  const handlers: ClaudeHookHandler[] = [];
  for (const group of groups) {
    if (claudeToolName && !matcherHits(group.matcher, claudeToolName)) continue;
    if (!claudeToolName && group.matcher && group.matcher !== "*") continue;
    handlers.push(...group.hooks.filter((hook) => !hook.type || hook.type === "command"));
  }
  return handlers;
}

export type ExecEnv = {
  cwd: string;
  env: NodeJS.ProcessEnv;
};

export function runHookCommand(
  hook: ClaudeHookHandler,
  stdin: HookStdinPayload,
  exec: ExecEnv,
): HookRunResult {
  const command = hook.command ?? "";
  const timeout = typeof hook.timeout === "number" && hook.timeout > 0 ? hook.timeout * 1000 : 30_000;
  const input = JSON.stringify(stdin);
  const args = Array.isArray(hook.args) ? hook.args.map(String) : [];
  const useShell = args.length === 0;
  const spawned = spawnSync(useShell ? command : command, useShell ? [] : args, {
    cwd: exec.cwd,
    env: exec.env,
    encoding: "utf8",
    input,
    timeout,
    shell: useShell,
    windowsHide: true,
  });
  const stdout = spawned.stdout ?? "";
  const stderr = spawned.stderr ?? "";
  const timedOut = Boolean(
    spawned.error && (spawned.error as NodeJS.ErrnoException).code === "ETIMEDOUT",
  );
  const exitCode = spawned.status ?? (spawned.signal ? 1 : 0);
  return { ...interpretHookResult(exitCode, stdout, stderr), timedOut };
}

export function runHookGroups(
  groups: ClaudeHookGroup[] | undefined,
  stdin: HookStdinPayload,
  exec: ExecEnv,
  claudeToolName?: string,
): HookRunResult[] {
  return matchingHandlers(groups, claudeToolName).map((hook) => runHookCommand(hook, stdin, exec));
}

export function firstBlock(results: HookRunResult[]): HookRunResult | undefined {
  return results.find((result) => result.blocked);
}

export function collectContext(results: HookRunResult[]): string[] {
  return results
    .map((result) => result.additionalContext)
    .filter((value): value is string => Boolean(value && value.trim()));
}
