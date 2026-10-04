/**
 * Server-side SSE filtering for HintLab.
 *
 * This is the single choke point between the server's internal (raw) event
 * stream and what may reach a browser. The agent emits unguarded model output
 * (`agent_text`, `reasoning`, and tool inputs/outputs that carry model free
 * text). We only ever forward a small allow-list of event types, and for each
 * of those we emit a sanitised payload that can never contain the model's own
 * words or raw SDK/stack-trace messages.
 *
 * Raw events are still recorded in the session (see `sessions.ts`) for
 * server-side logs/debugging; this module governs only what is streamed.
 */

import { extractCommands } from "./allowlist";

/** Event types that may ever be forwarded to a client. */
const ALLOWED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "test_results",
  "tool_call",
  "tool_result",
  "approval",
  "hint",
  "hint_status",
  "hint_rejected",
  "status",
  "error",
  "done",
]);

/** The only tool names we surface in `tool_call` / `tool_result`. */
const TOOL_CALL_TOOLS = new Set(["run_commands", "read_files", "run_tests"]);

export interface ClientEvent {
  name: string;
  data: unknown;
}

function asRecord(data: unknown): Record<string, unknown> {
  return data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Trim a potentially long string to a short, single-line summary. */
function trimSummary(value: unknown, max = 200): string {
  const s = asString(value).replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/** Recover one or more file paths from any accepted read_files input shape. */
function extractReadFileNames(input: unknown): string[] {
  const out: string[] = [];
  const visit = (v: unknown): void => {
    if (typeof v === "string") {
      out.push(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const direct = o.path ?? o.filePath ?? o.file_path;
      if (typeof direct === "string") {
        out.push(direct);
        return;
      }
      if (o.files !== undefined) visit(o.files);
    }
  };
  visit(input);
  return out;
}

/** Just the basename, so we never leak absolute sandbox paths to the browser. */
function basename(p: string): string {
  const n = p.split(/[\\/]/).filter(Boolean).pop();
  return n ?? p;
}

/** A test-results payload safe to show: no sandboxDir, trimmed stderr. */
export function sanitizeTestResults(data: unknown): Record<string, unknown> {
  const d = asRecord(data);
  const tests = Array.isArray(d.tests) ? (d.tests as Array<Record<string, unknown>>) : [];
  return {
    assignmentId: d.assignmentId,
    build: d.build
      ? {
          ok: (d.build as Record<string, unknown>).ok,
          timedOut: (d.build as Record<string, unknown>).timedOut,
          signal: (d.build as Record<string, unknown>).signal,
          stderr: trimSummary((d.build as Record<string, unknown>).stderr, 400),
        }
      : null,
    tests: tests.map((t) => ({
      name: t.name,
      input: asString(t.input),
      expected: asString(t.expected),
      got: asString(t.got),
      stderr: trimSummary(t.stderr, 400),
      exitCode: t.exitCode,
      signal: t.signal,
      timedOut: t.timedOut,
      passed: t.passed,
    })),
    passed: d.passed,
    failed: d.failed,
    total: d.total,
  };
}


function filterToolCall(data: unknown): ClientEvent | null {
  const d = asRecord(data);
  const toolName = asString(d.toolName);
  if (!TOOL_CALL_TOOLS.has(toolName)) return null;

  if (toolName === "run_commands") {
    const commands = extractCommands(d.input);
    return { name: "tool_call", data: { toolName, command: commands[0] ?? "" } };
  }

  if (toolName === "read_files") {
    const names = extractReadFileNames(d.input).map(basename);
    return { name: "tool_call", data: { toolName, file: names[0] ?? "" } };
  }

  // run_tests (custom, hardened) — only ever carries an optional test name.
  const input = asRecord(d.input);
  return {
    name: "tool_call",
    data: { toolName, testName: typeof input.testName === "string" ? input.testName : null },
  };
}

function filterToolResult(data: unknown): ClientEvent | null {
  const d = asRecord(data);
  const toolName = asString(d.toolName);

  if (toolName === "run_commands") {
    const output = d.output ?? d.error ?? "";
    return { name: "tool_result", data: { toolName, output: trimSummary(output, 200) } };
  }

  if (toolName === "run_tests") {
    const result = asRecord(d.output);
    const tests = Array.isArray(result.tests) ? (result.tests as Array<Record<string, unknown>>) : [];
    return {
      name: "tool_result",
      data: {
        toolName,
        passed: result.passed,
        failed: result.failed,
        total: result.total,
        build: result.build
          ? {
              ok: (result.build as Record<string, unknown>).ok,
              stderr: trimSummary((result.build as Record<string, unknown>).stderr, 200),
            }
          : null,
        tests: tests.map((t) => ({
          name: t.name,
          passed: t.passed,
          got: asString(t.got),
          expected: asString(t.expected),
          signal: t.signal,
          stderr: trimSummary(t.stderr, 200),
        })),
      },
    };
  }

  // read_files results are full file contents (student code) — drop them.
  return null;
}

function filterApproval(data: unknown): ClientEvent | null {
  const d = asRecord(data);
  const toolName = asString(d.toolName);
  const commands = Array.isArray(d.commands) ? d.commands.map((c) => asString(c)) : [];
  const allowed = d.allowed === true;
  return {
    name: "approval",
    data: {
      toolName,
      command: commands[0] ?? "",
      allowed,
      reason: allowed
        ? undefined
        : toolName === "run_commands"
          ? "Command blocked by allow-list"
          : "Tool not allowed in HintLab",
    },
  };
}

function filterHint(data: unknown): ClientEvent | null {
  const d = asRecord(data);
  return {
    name: "hint",
    data: { level: d.level, tag: d.tag, text: asString(d.text) },
  };
}

/** Map a guard rejection reason to a tiny, fixed category (never the text). */
function hintRejectCategory(reason: unknown): string {
  const r = asString(reason);
  if (r === "wrong level") return "wrong level";
  if (r === "empty hint") return "empty hint";
  return "contained code";
}

function filterHintRejected(data: unknown): ClientEvent | null {
  const d = asRecord(data);
  return {
    name: "hint_rejected",
    data: { level: d.level, reason: hintRejectCategory(d.reason) },
  };
}

function filterStatus(data: unknown): ClientEvent | null {
  const d = asRecord(data);
  if (typeof d.status === "string") return { name: "status", data: { status: d.status } };
  return null;
}

/** Turn a raw error into a short human line — never a stack trace / SDK text. */
function friendlyError(data: unknown): string {
  const raw = asString(asRecord(data).message);
  if (/timed?\s*out|timeout|ETIMEDOUT/i.test(raw)) return "Tutor timed out, try again";
  if (/allow-?list|forbidden token/i.test(raw)) return "Command blocked by allow-list";
  if (/hint|rephrase/i.test(raw)) return "Hint blocked, asking the tutor to rephrase";
  return "Something went wrong. Please try again.";
}

/**
 * Given a raw event, return the sanitised client event to stream, or `null` to
 * drop it entirely. Applied to live events and to the replay of buffered past
 * events, so the same contract holds for late joiners.
 */
export function filterEvent(rawName: string, rawData: unknown): ClientEvent | null {
  if (!ALLOWED_EVENT_TYPES.has(rawName)) return null;

  switch (rawName) {
    case "test_results":
      return { name: "test_results", data: sanitizeTestResults(rawData) };
    case "tool_call":
      return filterToolCall(rawData);
    case "tool_result":
      return filterToolResult(rawData);
    case "approval":
      return filterApproval(rawData);
    case "hint":
      return filterHint(rawData);
    case "hint_status":
    case "hint_rejected":
      return filterHintRejected(rawData);
    case "status":
      return filterStatus(rawData);
    case "error":
      return { name: "error", data: { message: friendlyError(rawData) } };
    case "done": {
      const d = asRecord(rawData);
      return { name: "done", data: { reason: asString(d.reason) || "done" } };
    }
    default:
      return null;
  }
}

/** The full allow-list of event types that may reach the client (for checks). */
export const CLIENT_EVENT_TYPES: readonly string[] = [...ALLOWED_EVENT_TYPES];

