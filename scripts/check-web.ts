import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import path from "node:path";

/**
 * check:web — starts the HintLab server on PORT=3200, verifies the static UI
 * and the SSE event contract end-to-end, then stops the server by PID.
 *
 * Assertions:
 *  - GET /          -> 200, contains the app title/root, references /app.js + /style.css
 *  - GET /app.js    -> 200
 *  - GET /style.css -> 200
 *  - GET /api/assignments -> 200, non-empty list
 *  - a real session's SSE stream never emits `agent_text` or `reasoning`
 */

const PORT = 3200;
const BASE = `http://127.0.0.1:${PORT}`;
const READY_TIMEOUT_MS = 30_000;
const HINT_TIMEOUT_MS = 180_000;

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

async function readSse(sessionId: string): Promise<{ eventTypes: Set<string>; hint: unknown }> {
  const eventTypes = new Set<string>();
  let hint: unknown = null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HINT_TIMEOUT_MS);

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
        eventTypes.add(name);
        let data: unknown;
        try {
          data = JSON.parse(dataLines.join("\n"));
        } catch {
          data = dataLines.join("\n");
        }
        if (name === "hint") {
          if (hint === null) hint = data;
          return { eventTypes, hint };
        }
      }
    }
  } catch {
    /* aborted on timeout or closed — fine */
  } finally {
    clearTimeout(timeout);
  }
  return { eventTypes, hint };
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

async function main(): Promise<void> {
  const tsxCli = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  const child = spawn(process.execPath, [tsxCli, "src/server.ts"], {
    env: { ...process.env, PORT: String(PORT) },
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
  child.on("error", (e) => {
    console.error("server process failed to start:", e.message);
  });

  try {
    await waitForReady();
    console.log("server ready on PORT=3200");

    // --- static UI ---
    const index = await fetch(`${BASE}/`);
    check(index.status === 200, `GET / -> 200 (got ${index.status})`);
    const html = await index.text();
    check(html.includes("HintLab"), "GET / contains the app title/root");
    check(html.includes("never writes the fix"), "GET / contains the app tagline");
    check(html.includes("/app.js"), "GET / references /app.js");
    check(html.includes("/style.css"), "GET / references /style.css");

    const js = await fetch(`${BASE}/app.js`);
    check(js.status === 200, `GET /app.js -> 200 (got ${js.status})`);
    const css = await fetch(`${BASE}/style.css`);
    check(css.status === 200, `GET /style.css -> 200 (got ${css.status})`);

    // --- assignments ---
    const assignmentsRes = await fetch(`${BASE}/api/assignments`);
    check(assignmentsRes.status === 200, `GET /api/assignments -> 200 (got ${assignmentsRes.status})`);
    const assignments = (await assignmentsRes.json()) as Array<{
      id?: string;
      language?: string;
      starterCode?: string;
    }>;
    check(Array.isArray(assignments) && assignments.length > 0, "GET /api/assignments returns a non-empty list");
    const ids = assignments.map((a) => a.id).join(",");
    console.log(`assignments: ${ids}`);
    check(
      assignments.every((a) => typeof a.id === "string" && typeof a.starterCode === "string"),
      "each assignment has an id and starter code",
    );

    // --- real session + SSE ---
    const assignmentId = assignments.some((a) => a.id === "is-palindrome") ? "is-palindrome" : "average-marks";
    const starter = assignments.find((a) => a.id === assignmentId)?.starterCode ?? "";
    const postRes = await fetch(`${BASE}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assignmentId, code: starter }),
    });
    check(postRes.status === 200, `POST /api/session -> 200 (got ${postRes.status})`);
    const postBody = (await postRes.json()) as { sessionId?: string };
    const sessionId = postBody.sessionId;
    check(!!sessionId, "POST /api/session returns a sessionId");
    if (!sessionId) throw new Error("no sessionId returned");
    console.log(`session ${sessionId} started on assignment ${assignmentId}`);

    const { eventTypes, hint } = await readSse(sessionId);

    check(
      !eventTypes.has("agent_text") && !eventTypes.has("reasoning"),
      "SSE stream never emits agent_text or reasoning",
    );

    console.log("\n=== distinct SSE event types seen ===");
    console.log([...eventTypes].sort().join(", "));

    console.log("\n=== level-1 hint ===");
    if (hint && typeof hint === "object") {
      console.log(JSON.stringify(hint, null, 2));
    } else {
      console.log("(no level-1 hint received within the timeout)");
    }
  } catch (err) {
    if (serverOutput.trim()) {
      console.error("--- server output ---\n" + serverOutput.trim());
    }
    throw err;
  } finally {
    killTree(child);
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
