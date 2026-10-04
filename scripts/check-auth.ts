import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AUTH_FAILURE_CODE, AUTH_FAILURE_MESSAGE } from "../src/authFailure";

/**
 * check:auth — proves the "tutor not authenticated" path end-to-end without
 * touching ~/.cline.
 *
 * How the failure is forced:
 *   - the server is started with HINTLAB_PROVIDER_ID=anthropic and
 *     HINTLAB_MODEL_ID=claude-sonnet-4-5 (a provider that needs an API key);
 *   - CLINE_DIR / CLINE_DATA_DIR are pointed at an empty temp dir, so the SDK
 *     reads an empty providers.json (no anthropic apiKey) instead of ~/.cline;
 *   - ANTHROPIC_API_KEY / OPENAI_API_KEY are removed from the child env so the
 *     SDK cannot fall back to an environment key.
 *
 * The check POSTs /api/session, reads the SSE stream, and asserts that an
 * `error` event carrying `code: "auth"` and the exact auth message arrives,
 * that the server log prints the line once for that session, and that no hint
 * was produced. It stops the server by PID.
 */

const PORT = 3200;
const BASE = `http://127.0.0.1:${PORT}`;
const READY_TIMEOUT_MS = 30_000;
const AUTH_TIMEOUT_MS = 60_000;

const PROVIDER_ID = "anthropic";
const MODEL_ID = "claude-sonnet-4-5";

let failures = 0;
function check(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  PASS  ${msg}`);
  } else {
    console.error(`  FAIL  ${msg}`);
    failures += 1;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Best-effort secret redaction for any raw SDK text we report. */
function redact(text: string): string {
  return String(text)
    .replace(/\b(bearer\s+)[A-Za-z0-9._\-]+/gi, "$1[redacted]")
    .replace(/\b(api[_-]?key|apikey|token|secret|password|authorization)\b[\s"'`:=]*[:=][\s"'`:=]*[A-Za-z0-9._\-]+/gi, "$1=[redacted]")
    .replace(/\bsk-[A-Za-z0-9._\-]+/gi, "sk-[redacted]")
    .replace(/\b[A-Za-z0-9]{32,}\b/g, "[redacted]");
}

async function waitForReady(): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error("server did not become ready in time");
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform !== "win32") {
      process.kill(-child.pid, "SIGKILL");
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}
interface SseOutcome {
  authError: { code?: string; message?: string } | null;
  hintSeen: boolean;
  errorStatusSeen: boolean;
}

/** Read the SSE stream until the auth error + error status arrive (or timeout). */
async function readSse(sessionId: string): Promise<SseOutcome> {
  const outcome: SseOutcome = { authError: null, hintSeen: false, errorStatusSeen: false };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);

  try {
    const res = await fetch(`${BASE}/api/session/${sessionId}/stream`, { signal: controller.signal });
    if (!res.body) throw new Error("no response body");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let name = "message";
        const dataLines: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) continue;
          if (line.startsWith("event:")) name = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
        }
        if (dataLines.length === 0) continue;
        let data: unknown;
        try {
          data = JSON.parse(dataLines.join("\n"));
        } catch {
          data = dataLines.join("\n");
        }
        const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
        if (name === "error") {
          if (outcome.authError === null) {
            outcome.authError = {
              code: typeof d.code === "string" ? d.code : undefined,
              message: typeof d.message === "string" ? d.message : undefined,
            };
          }
        } else if (name === "hint") {
          outcome.hintSeen = true;
        } else if (name === "status" && d.status === "error") {
          outcome.errorStatusSeen = true;
        }
        if (outcome.authError && outcome.errorStatusSeen) return outcome;
      }
    }
  } catch {
    /* aborted on timeout or closed — fine */
  } finally {
    clearTimeout(timeout);
  }
  return outcome;
}

/** Directly observe the raw SDK error (same forced env), for the report. */
async function captureRawSdkError(tmpDir: string): Promise<string> {
  const prev = {
    dir: process.env.CLINE_DIR,
    data: process.env.CLINE_DATA_DIR,
    key: process.env.ANTHROPIC_API_KEY,
    openai: process.env.OPENAI_API_KEY,
  };
  process.env.CLINE_DIR = tmpDir;
  process.env.CLINE_DATA_DIR = path.join(tmpDir, "data");
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;

  try {
    const { ClineCore } = await import("@cline/sdk");
    const cline = await ClineCore.create({ clientName: "hintlab-check-auth", backendMode: "local" });

    let captured: string | null = null;
    cline.subscribe((e: unknown) => {
      const ev = e as { type?: string; payload?: { sessionId?: string; event?: { type?: string; error?: unknown; errorClass?: string } } };
      if (captured) return;
      if (ev.type === "agent_event" && ev.payload?.event?.type === "error") {
        const err = ev.payload.event.error;
        captured = redact(err instanceof Error ? err.message : String(err ?? ev.payload.event.errorClass ?? "unknown"));
      }
    });

    try {
      await cline.start({
        interactive: true,
        prompt: "diagnose",
        config: {
          sessionId: "check-auth-probe",
          providerId: PROVIDER_ID,
          modelId: MODEL_ID,
          temperature: 0,
          systemPrompt: "diagnose",
          enableTools: false,
          enableSpawnAgent: false,
          enableAgentTeams: false,
        },
      });
      // If start() resolved, the error is asynchronous; give it a moment.
      const deadline = Date.now() + 20_000;
      while (!captured && Date.now() < deadline) await sleep(200);
    } catch (err) {
      captured = redact(err instanceof Error ? err.message : String(err));
    }

    return captured ?? "raw SDK error not captured within timeout";
  } finally {
    if (prev.dir === undefined) delete process.env.CLINE_DIR;
    else process.env.CLINE_DIR = prev.dir;
    if (prev.data === undefined) delete process.env.CLINE_DATA_DIR;
    else process.env.CLINE_DATA_DIR = prev.data;
    if (prev.key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prev.key;
    if (prev.openai === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prev.openai;
  }
}

async function main(): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hintlab-auth-"));

  console.log("=== check:auth ===");
  console.log(
    `forcing unauthenticated provider: HINTLAB_PROVIDER_ID=${PROVIDER_ID} ` +
      `HINTLAB_MODEL_ID=${MODEL_ID}, CLINE_DIR=${tmpDir} (empty providers.json), ` +
      `ANTHROPIC_API_KEY/OPENAI_API_KEY unset`,
  );

  // --- raw SDK error (direct probe, same forced env) ---
  const rawError = await captureRawSdkError(tmpDir);
  console.log(`raw SDK error (redacted): ${rawError}`);

  // --- end-to-end through the server ---
  const tsxCli = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  const childEnv = { ...process.env };
  delete childEnv.ANTHROPIC_API_KEY;
  delete childEnv.OPENAI_API_KEY;
  childEnv.PORT = String(PORT);
  childEnv.HINTLAB_PROVIDER_ID = PROVIDER_ID;
  childEnv.HINTLAB_MODEL_ID = MODEL_ID;
  childEnv.CLINE_DIR = tmpDir;
  childEnv.CLINE_DATA_DIR = path.join(tmpDir, "data");

  const child = spawn(process.execPath, [tsxCli, "src/server.ts"], {
    env: childEnv,
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let serverOutput = "";
  child.stdout?.on("data", (d) => {
    serverOutput += d.toString();
  });
  child.stderr?.on("data", (d) => {
    serverOutput += d.toString();
  });

  let sessionId = "";
  try {
    await waitForReady();
    console.log(`server ready on PORT=${PORT}`);

    const postRes = await fetch(`${BASE}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assignmentId: "sum-of-list" }),
    });
    check(postRes.status === 200, `POST /api/session -> 200 (got ${postRes.status})`);
    const postBody = (await postRes.json()) as { sessionId?: string };
    sessionId = postBody.sessionId ?? "";
    check(!!sessionId, "POST /api/session returns a sessionId");
    if (!sessionId) throw new Error("no sessionId returned");
    console.log(`session ${sessionId} started`);

    const outcome = await readSse(sessionId);
    check(outcome.authError !== null, "an error event arrived within the timeout");
    check(
      outcome.authError?.code === AUTH_FAILURE_CODE,
      `error event carries code "${AUTH_FAILURE_CODE}" (got ${outcome.authError?.code ?? "none"})`,
    );
    check(
      outcome.authError?.message === AUTH_FAILURE_MESSAGE,
      `error event carries the exact message "${AUTH_FAILURE_MESSAGE}"`,
    );
    check(!outcome.hintSeen, "no hint was produced");
    check(outcome.errorStatusSeen, "session status ends as error");

    check(
      serverOutput.includes(`[session ${sessionId}] ${AUTH_FAILURE_MESSAGE}`),
      `server log contains the auth line once for session ${sessionId}`,
    );

    if (serverOutput.trim()) {
      console.log("--- server output (trimmed) ---");
      console.log(serverOutput.trim().split("\n").slice(0, 40).join("\n"));
    }
  } finally {
    killTree(child);
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  // The raw-error probe above leaves SDK handles (telemetry timers) open, so exit explicitly.
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

