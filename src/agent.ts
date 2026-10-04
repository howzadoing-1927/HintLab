import path from "node:path";
import { ClineCore, createTool } from "@cline/sdk";
import type { AgentTool } from "@cline/sdk";
import { z } from "zod";
import { extractCommands } from "./allowlist";
import { loadAssignment } from "./assignments";
import { AGENT_TURN_TIMEOUT_MS, HINTLAB_MODEL_ID, HINTLAB_PROVIDER_ID } from "./config";
import { categorizeHintReason, checkHint } from "./hintGuard";
import { runTestsInWorkdir } from "./runner";
import {
  emitEvent,
  getSession,
  recordHint,
  registerAgentSession,
  setStatus,
  setStopAgentHook,
} from "./sessions";
import type { Session } from "./types";

let clineCorePromise: Promise<ClineCore> | null = null;

const SYSTEM_PROMPT = [
  "You are HintLab, a programming tutor that helps a student debug their lab assignment.",
  "",
  "Diagnose why the student's program fails its tests, then help the student figure it out",
  "on their own. You may read files (read_files, search_codebase) and re-run the student's",
  "tests with the run_tests tool.",
  "",
  "Hard rules:",
  "- NEVER write, edit, or show corrected code — not in tool calls, not in your text.",
  "  The file-editing tools are disabled for you; do not attempt them.",
  "- Do NOT put code, code snippets, or a rewritten solution in any message or hint.",
  "- The ONLY way to help is through the give_hint tool. Call it exactly once per turn, at",
  "  the level you were asked for.",
  "- give_hint levels: 1 = a conceptual nudge; 2 = point to the area or line of the bug;",
  "  3 = a near-explicit explanation of the bug and the concept. No level may include code.",
  "- After calling give_hint, finish your turn with a brief, code-free message.",
  "- You do not have a shell command tool. To execute the student's program, call run_tests",
  "  (optionally with a single test name). It runs safely inside the assignment workdir.",
].join("\n");

const GIVE_HINT_DESCRIPTION = [
  "Show the student exactly one hint at the requested level.",
  "level 1 = a conceptual nudge; level 2 = point to the area or line of the bug;",
  "level 3 = a near-explicit explanation of the bug and the underlying concept.",
  "Never include code or a corrected solution in the text. Use plain prose only.",
  "An optional short `tag` (e.g. \"off-by-one\") is fine.",
].join(" ");

/**
 * The shared give_hint tool. It is the only hint sink: the server-side guard runs
 * here before a hint is recorded, and a rejected hint becomes a tool error so the
 * model rephrases instead of the hint reaching the student.
 */
const giveHintTool = createTool({
  name: "give_hint",
  description: GIVE_HINT_DESCRIPTION,
  inputSchema: z.object({
    level: z.number().int().min(1).max(3),
    tag: z.string().optional(),
    text: z.string(),
  }),
  async execute(input, context) {
    const session = context.sessionId ? getSession(context.sessionId) : undefined;
    const wanted = session?.currentHintLevel ?? input.level;

    if (session && input.level !== wanted) {
      emitEvent(session, "hint_rejected", {
        level: input.level,
        wantedLevel: wanted,
        reason: "wrong level",
      });
      throw new Error(
        `You were asked for a level ${wanted} hint, but called give_hint with level ${input.level}. ` +
          `Call give_hint again with level ${wanted}.`,
      );
    }

    if (session && session.hints.some((h) => h.level === input.level)) {
      // This level was already delivered; tell the model to stop without erroring,
      // so it finishes its turn instead of retrying forever.
      return {
        shown: false,
        alreadyDelivered: true,
        message: `The level ${input.level} hint was already delivered. Do not call give_hint again; finish your turn.`,
      };
    }

    const guard = checkHint(input.text);
    if (!guard.ok) {
      if (session) {
        // Never surface the rejected text — only a fixed reason category.
        emitEvent(session, "hint_rejected", {
          level: input.level,
          reason: categorizeHintReason(guard.reason),
        });
      }
      throw new Error(
        `HintLab rejected this hint: ${guard.reason}. Rephrase the hint in plain prose with no code, ` +
          `then call give_hint again.`,
      );
    }

    const hint = {
      level: input.level as 1 | 2 | 3,
      tag: input.tag,
      text: input.text,
      at: new Date().toISOString(),
    };
    if (session) {
      recordHint(session, hint);
    }
    return { shown: true, level: input.level };
  },
});

const RUN_TESTS_DESCRIPTION = [
  "Run the student's program against the assignment's test cases, inside its sandbox.",
  "Optionally pass a single test name to run only that test.",
  "Returns per-test input, expected, got, stderr, signal and pass/fail.",
  "Safe: process-group kill, per-test timeouts, and a minimal environment.",
].join(" ");

/**
 * The hardened test runner exposed to the agent. It replaces the SDK's built-in
 * run_commands (which is disabled) so that student code run by the agent goes
 * through the server's own runner — process-group kill, timeouts, and a minimal
 * env with HOME set to the sandbox dir. Student code therefore can never read
 * the server's environment or the credentials in ~/.cline.
 */
const runTestsTool = createTool({
  name: "run_tests",
  description: RUN_TESTS_DESCRIPTION,
  inputSchema: z.object({ testName: z.string().optional() }),
  async execute(input, context) {
    const session = context.sessionId ? getSession(context.sessionId) : undefined;
    if (!session) {
      return { error: "no active session" };
    }
    const assignment = loadAssignment(session.assignmentId);
    return runTestsInWorkdir(assignment, session.workdir, input.testName);
  },
});


function toolPolicies() {
  return {
    read_files: { autoApprove: true },
    search_codebase: { autoApprove: true },
    run_commands: { enabled: false },
    editor: { enabled: false },
    apply_patch: { enabled: false },
    fetch_web_content: { enabled: false },
    skills: { enabled: false },
    ask_question: { enabled: false },
    submit_and_exit: { enabled: false },
    give_hint: { autoApprove: true },
    run_tests: { autoApprove: true },
  };
}

function capabilities() {
  return {
    // Every tool that is not explicitly auto-approved is denied. run_commands is
    // disabled at the policy level (and would be denied here as defence-in-depth),
    // so a command attempt is still blocked and shown as an approval-denied line.
    requestToolApproval: async (req: {
      sessionId: string;
      toolName: string;
      toolCallId: string;
      input: unknown;
    }) => {
      const session = getSession(req.sessionId);
      const commands = extractCommands(req.input);
      const reason =
        req.toolName === "run_commands"
          ? "Command blocked by allow-list"
          : `Tool "${req.toolName}" is not allowed in HintLab`;

      if (session) {
        emitEvent(session, "approval", {
          toolName: req.toolName,
          toolCallId: req.toolCallId,
          commands,
          allowed: false,
          reason,
        });
      }
      return { approved: false, reason };
    },
  };
}

/** Map the raw SDK events to HintLab SSE events, routed by session id. */
function handleCoreEvent(e: {
  type: string;
  payload?: { sessionId?: string; event?: Record<string, unknown>; [k: string]: unknown };
}): void {
  const sessionId = e.payload?.sessionId;
  if (!sessionId) return;
  const session = getSession(sessionId);
  if (!session) return;

  if (e.type === "agent_event") {
    const ev = e.payload?.event as Record<string, unknown> | undefined;
    if (!ev) return;
    switch (ev.type) {
      case "content_start":
        // Only tool starts are forwarded (and then filtered to the allow-list).
        // Model text and reasoning are dropped here and never emitted.
        if (ev.contentType === "tool") {
          emitEvent(session, "tool_call", { toolName: ev.toolName, toolCallId: ev.toolCallId, input: ev.input });
        }
        break;
      case "content_end":
        if (ev.contentType === "tool") {
          emitEvent(session, "tool_result", {
            toolName: ev.toolName,
            toolCallId: ev.toolCallId,
            output: ev.output,
            error: ev.error,
            durationMs: ev.durationMs,
          });
        }
        break;
      case "done":
        emitEvent(session, "done", { reason: ev.reason });
        break;
      case "error":
        emitEvent(session, "error", {
          message: ev.error instanceof Error ? ev.error.message : String(ev.error),
        });
        break;
      default:
        break;
    }
    return;
  }

  if (e.type === "status") {
    emitEvent(session, "status", { status: e.payload?.status });
  } else if (e.type === "ended") {
    emitEvent(session, "done", { reason: e.payload?.reason });
  } else if (e.type === "hook") {
    const payload = e.payload as Record<string, unknown>;
    emitEvent(session, "status", { hook: payload.hookEventName, toolName: payload.toolName });
  }
}


/** Lazily create the one shared ClineCore instance and subscribe once. */
async function getCline(): Promise<ClineCore> {
  if (!clineCorePromise) {
    clineCorePromise = (async () => {
      const cline = await ClineCore.create({ clientName: "hintlab", backendMode: "local" });
      cline.subscribe((e: unknown) => handleCoreEvent(e as Parameters<typeof handleCoreEvent>[0]));
      return cline;
    })();
  }
  return clineCorePromise;
}

// Register the hook so session cleanup can stop the SDK session too.
setStopAgentHook((agentSessionId) => {
  if (!clineCorePromise) return;
  clineCorePromise
    .then((cline) => cline.stop(agentSessionId).catch(() => undefined))
    .catch(() => undefined);
});

function buildTestResultsText(session: Session): string {
  const lines: string[] = [];
  for (const t of session.testResults.tests) {
    lines.push(
      `- ${t.name}: input=${JSON.stringify(t.input)} expected=${JSON.stringify(t.expected)} got=${JSON.stringify(t.got)} ` +
        `(passed=${t.passed})`,
    );
  }
  if (session.testResults.build && !session.testResults.build.ok) {
    lines.push(`(build failed: ${session.testResults.build.stderr.trim().slice(0, 400)})`);
  }
  return lines.join("\n");
}

function buildFirstPrompt(session: Session, mainPath: string, testsPath: string): string {
  return [
    `The student is working on assignment "${session.assignmentId}" (${session.language}): ${session.statement}`,
    "",
    `Files (use these ABSOLUTE paths with read_files):`,
    `- Student code: ${mainPath}`,
    `- Tests: ${testsPath}`,
    "",
    "The program was already run against the test cases. Results:",
    buildTestResultsText(session),
    "",
    "Diagnose the root cause of the failure(s). Read the files, then call the run_tests tool",
    "(optionally with a single test name) to re-run the student's tests and confirm your",
    "diagnosis. Then call the give_hint tool EXACTLY ONCE with level 1 (a conceptual nudge).",
    "Do not write or show corrected code, and do not call give_hint more than once.",
  ].join("\n");
}

function buildNextPrompt(_session: Session, level: number): string {
  return [
    "The student is still stuck and asked for the next hint.",
    `Give the next hint at level ${level}`,
    "(1 = conceptual nudge, 2 = where to look, 3 = near-explicit concept).",
    `Call the give_hint tool EXACTLY ONCE with level ${level}. Do not write or show corrected code.`,
  ].join("\n");
}

/** Resolve/reject a promise within `ms`, with a friendly timeout message. */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Run the first (level-1) agent turn in the background for a session. */
export async function startSession(sessionId: string): Promise<void> {
  const session = getSession(sessionId);
  if (!session) return;

  const mainFile = session.language === "python" ? "main.py" : "main.c";
  const mainPath = path.resolve(session.workdir, mainFile);
  const testsPath = path.resolve(session.workdir, "tests.json");

  const cline = await getCline();
  session.busy = true;
  setStatus(session, "running");

  try {
    const startPromise = cline.start({
      interactive: true,
      prompt: buildFirstPrompt(session, mainPath, testsPath),
      config: {
        sessionId: session.id,
        providerId: HINTLAB_PROVIDER_ID,
        modelId: HINTLAB_MODEL_ID,
        temperature: 0,
        systemPrompt: SYSTEM_PROMPT,
        // session.workdir is the runner's temp sandbox dir, kept alive for the
        // agent via runAssignment(..., { cleanup: false }) in app.ts. It is the
        // agent's whole sandbox and is removed by the session cleanup loop when
        // the session ends/TTL expires (see sessions.ts deleteSession).
        cwd: session.workdir,
        workspaceRoot: session.workdir,
        enableTools: true,
        enableSpawnAgent: false,
        enableAgentTeams: false,
        extraTools: [giveHintTool as unknown as AgentTool, runTestsTool as unknown as AgentTool],
      },
      toolPolicies: toolPolicies(),
      capabilities: capabilities(),
    });
    startPromise.catch(() => undefined); // swallow late settle after a timeout

    const result = await withTimeout(startPromise, AGENT_TURN_TIMEOUT_MS, "Tutor timed out, try again");

    session.agentSessionId = result.sessionId;
    registerAgentSession(result.sessionId, session.id);
    const finishReason = (result.result as { finishReason?: string } | undefined)?.finishReason;
    emitEvent(session, "status", { message: "initial agent turn finished", finishReason });
  } catch (err) {
    emitEvent(session, "error", { message: err instanceof Error ? err.message : String(err) });
    setStatus(session, "error");
  } finally {
    session.busy = false;
    if (session.status !== "error") {
      setStatus(session, session.hints.length >= 3 ? "complete" : "idle");
    }
  }
}

/** Ask the agent for the next hint level (2, then 3). Returns after the turn completes. */
export async function nextHint(sessionId: string): Promise<{ level: number; status: string; message?: string }> {
  const session = getSession(sessionId);
  if (!session) throw Object.assign(new Error("unknown session"), { status: 404 });
  if (session.busy) throw Object.assign(new Error("agent is still busy"), { status: 409 });
  if (session.hints.length >= 3) {
    return { level: 3, status: "complete", message: "All three hint levels have already been delivered." };
  }

  const nextLevel = Math.min(session.hints.length + 1, 3);
  session.currentHintLevel = nextLevel;
  session.busy = true;
  setStatus(session, "running");

  const cline = await getCline();
  try {
    const sendPromise = cline.send({
      sessionId: session.agentSessionId ?? session.id,
      prompt: buildNextPrompt(session, nextLevel),
    });
    sendPromise.catch(() => undefined); // swallow late settle after a timeout
    const result = await withTimeout(sendPromise, AGENT_TURN_TIMEOUT_MS, "Tutor timed out, try again");
    const finishReason = (result as { finishReason?: string } | undefined)?.finishReason;
    emitEvent(session, "status", { message: `level ${nextLevel} agent turn finished`, finishReason });
  } catch (err) {
    emitEvent(session, "error", { message: err instanceof Error ? err.message : String(err) });
    setStatus(session, "error");
  } finally {
    session.busy = false;
    if (session.status !== "error") {
      setStatus(session, session.hints.length >= 3 ? "complete" : "idle");
    }
  }

  return { level: nextLevel, status: session.status };
}

// Export the tool so tests can inspect it if needed.
export { giveHintTool };

