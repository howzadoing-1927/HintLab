import { allowCommand, allowCommands, extractCommands } from "../src/allowlist";
import { createApp } from "../src/app";
import { loadAssignment } from "../src/assignments";
import { checkHint } from "../src/hintGuard";
import { HINTLAB_MODEL_ID, HINTLAB_PROVIDER_ID } from "../src/config";

const PORT = 3200;
const BASE = `http://127.0.0.1:${PORT}`;
const OVERALL_TIMEOUT_MS = 8 * 60 * 1000;

let failures = 0;
function check(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  PASS  ${msg}`);
  } else {
    console.error(`  FAIL  ${msg}`);
    failures += 1;
  }
}

// ---------------------------------------------------------------------------
// Unit tests: run_commands allow-list (deterministic, no model call).
// ---------------------------------------------------------------------------
function unitTestAllowList(): void {
  console.log("\n=== unit tests: run_commands allow-list ===");

  check(allowCommand("python3 main.py").allowed, "allow python3 main.py");
  check(allowCommand("python3 main.py < input.txt").allowed, "allow python3 main.py < input.txt");
  check(allowCommand("echo '1 2 3' | python3 main.py").allowed, "allow echo '1 2 3' | python3 main.py");
  check(allowCommand("printf '2\\n10 20\\n' | python3 main.py").allowed, "allow printf '2\\n10 20\\n' | python3 main.py");
  check(allowCommand("gcc -Wall -O0 main.c -o main").allowed, "allow gcc -Wall -O0 main.c -o main");
  check(allowCommand("./main").allowed, "allow ./main");
  check(allowCommand("./main < input.txt").allowed, "allow ./main < input.txt");
  check(allowCommand("echo '2\\n10 20\\n' | ./main").allowed, "allow echo ... | ./main");
  check(allowCommand("cat main.py").allowed, "allow cat main.py");
  check(allowCommand("cat main.c").allowed, "allow cat main.c");
  check(allowCommand("cat tests.json").allowed, "allow cat tests.json");

  check(!allowCommand("python3 main.py; rm -rf ~").allowed, "deny 'python3 main.py; rm -rf ~'");
  check(!allowCommand("cat /etc/passwd").allowed, "deny 'cat /etc/passwd'");
  check(!allowCommand("python3 main.py && rm -rf ~").allowed, "deny '&&' injection");
  check(!allowCommand("python3 main.py || rm -rf ~").allowed, "deny '||' injection");
  check(!allowCommand("python3 main.py | bash").allowed, "deny extra pipe");
  check(!allowCommand("echo $(rm -rf ~) | python3 main.py").allowed, "deny '$()' injection");
  check(!allowCommand("echo `id` | python3 main.py").allowed, "deny backtick injection");
  check(!allowCommand("python3 main.py > /tmp/out").allowed, "deny output redirect");
  check(!allowCommand("python3 main.py < /etc/passwd").allowed, "deny absolute stdin redirect");
  check(!allowCommand("python3 main.py < ../secret").allowed, "deny parent-path stdin redirect");
  check(!allowCommand("rm -rf /tmp/x").allowed, "deny 'rm -rf'");
  check(!allowCommand("gcc main.c -o main").allowed, "deny gcc without the exact build flags");
  check(!allowCommand("ls /").allowed, "deny 'ls /'");

  // extractCommands handles string, string[], {commands:[]}, and {command,args}.
  check(
    JSON.stringify(extractCommands({ commands: ["python3 main.py"] })) === JSON.stringify(["python3 main.py"]),
    "extractCommands({commands:[...]})",
  );
  check(
    JSON.stringify(extractCommands(["python3 main.py", "cat tests.json"])) ===
      JSON.stringify(["python3 main.py", "cat tests.json"]),
    "extractCommands(string[])",
  );
  check(
    JSON.stringify(extractCommands({ command: "python3 main.py" })) === JSON.stringify(["python3 main.py"]),
    "extractCommands({command})",
  );
  check(
    allowCommands(["python3 main.py", "cat tests.json"]).allowed,
    "allowCommands allows a list of allowed commands",
  );
  check(
    !allowCommands(["python3 main.py", "rm -rf /"]).allowed,
    "allowCommands denies a list containing a forbidden command",
  );
}

// ---------------------------------------------------------------------------
// Unit tests: hint guard (deterministic, no model call).
// ---------------------------------------------------------------------------
function unitTestHintGuard(): void {
  console.log("\n=== unit tests: hint guard ===");

  check(checkHint("Think about which index your loop starts from.").ok, "pass: conceptual nudge");
  check(checkHint("Look at the line where the sum is accumulated.").ok, "pass: where-to-look");
  check(checkHint("The average is truncated because both operands are integers.").ok, "pass: concept (no code)");

  check(!checkHint("```python\nfor i in range(0, len(nums)):\n    total += nums[i]\n```").ok, "reject: fenced code block");
  check(!checkHint("The fix is `for i in range(0, len(nums)):`.").ok, "reject: inline code solution");
  check(!checkHint("Change `float avg = sum / n;` to `float avg = (float) sum / n;`.").ok, "reject: corrected C line");
  check(!checkHint("Use print(sum(nums)) instead.").ok, "reject: print(...) solution");
  check(!checkHint("for i in range(len(nums)):\ntotal += nums[i]").ok, "reject: multi-line source code");
  check(!checkHint("Just call sum() to add them up.").ok, "reject: function-call hint");
}

async function waitUntil(fn: () => boolean, what: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${what}`);
}

interface SseRecord {
  name: string;
  data: unknown;
}

// Independent code markers (beyond the guard) used to re-verify hints contain no code.
function hasCodeMarker(text: string): boolean {
  if (text.includes("```")) return true;
  return /(?:\bdef\s+\w+\s*\(|\bprint\s*\(|\bprintf\s*\(|\bscanf\s*\(|\brange\s*\(|\blen\s*\(|\bsum\s*\(|\bfor\s+\w+\s+in\s|\bwhile\s*\(|\bif\s*\(|\(float\)|\(int\)|;\s*$)/.test(
    text,
  );
}

// ---------------------------------------------------------------------------
// End-to-end: real model call against a local server on PORT 3200.
// ---------------------------------------------------------------------------
async function e2e(): Promise<void> {
  const assignment = loadAssignment("sum-of-list");
  const code = assignment.starterCode;

  const postRes = await fetch(`${BASE}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assignmentId: "sum-of-list", code }),
  });
  check(postRes.status === 200, `POST /api/session -> 200 (got ${postRes.status})`);
  const postBody = (await postRes.json()) as { sessionId?: string; testResults?: { total?: number; passed?: number } };
  const sessionId = postBody.sessionId;
  check(!!sessionId, "POST /api/session returns a sessionId");
  check(
    postBody.testResults?.total === 4 && postBody.testResults?.passed === 0,
    `sum-of-list buggy starter fails 0/4 (got ${postBody.testResults?.passed}/${postBody.testResults?.total})`,
  );
  console.log("\n=== session ===");
  console.log("assignmentId: sum-of-list");
  console.log("sessionId:", sessionId);

  const events: SseRecord[] = [];
  const hints: Array<{ level: number; tag?: string; text: string }> = [];
  const approvals: Array<{ toolName?: string; commands?: string[]; allowed?: boolean; reason?: string }> = [];
  const toolCalls: Array<{ toolName?: string }> = [];
  const eventTypes = new Set<string>();
  let lastStatus = "";

  const controller = new AbortController();
  const streamTask = (async () => {
    const res = await fetch(`${BASE}/api/session/${sessionId}/stream`, { signal: controller.signal });
    check(res.status === 200, `SSE stream -> 200 (got ${res.status})`);
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
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
          events.push({ name, data });
          eventTypes.add(name);
          if (name === "hint") hints.push(data as { level: number; tag?: string; text: string });
          else if (name === "approval") approvals.push(data as { toolName?: string; commands?: string[]; allowed?: boolean; reason?: string });
          else if (name === "tool_call") toolCalls.push(data as { toolName?: string });
          else if (name === "status" && data && typeof (data as { status?: unknown }).status === "string") {
            lastStatus = (data as { status: string }).status;
          }
        }
      }
    } catch {
      // stream aborted/closed — expected at the end
    }
  })();




  try {
    // The agent was started in the background by POST; wait for the level-1 hint.
    await waitUntil(() => hints.some((h) => h.level === 1), "level-1 hint over SSE", 240000);

    // The hint is delivered *during* the turn; wait for the agent to finish that
    // turn (busy=false) before asking for the next level.
    await waitUntil(() => lastStatus === "idle" || lastStatus === "complete", "agent idle after level-1 hint", 120000);

    // Ask for level 2.
    let nh = await fetch(`${BASE}/api/session/${sessionId}/next-hint`, { method: "POST" });
    check(nh.status === 200, `next-hint (level 2) -> 200 (got ${nh.status})`);
    console.log("next-hint (level 2) response:", await nh.clone().json());
    await waitUntil(() => hints.some((h) => h.level === 2), "level-2 hint over SSE", 240000);

    // Ask for level 3.
    nh = await fetch(`${BASE}/api/session/${sessionId}/next-hint`, { method: "POST" });
    check(nh.status === 200, `next-hint (level 3) -> 200 (got ${nh.status})`);
    console.log("next-hint (level 3) response:", await nh.clone().json());
    await waitUntil(() => hints.some((h) => h.level === 3), "level-3 hint over SSE", 240000);

    // A fourth request should report "complete".
    nh = await fetch(`${BASE}/api/session/${sessionId}/next-hint`, { method: "POST" });
    const nh4 = (await nh.json()) as { status?: string; level?: number; message?: string };
    check(nh4.status === "complete", `next-hint after level 3 -> complete (got ${JSON.stringify(nh4)})`);
    console.log("next-hint (after level 3) response:", nh4);
  } finally {
    controller.abort();
    await streamTask;
  }

  // --- assertions ---
  console.log("\n=== assertions ===");
  const byLevel = (l: number) => hints.filter((h) => h.level === l);
  check(byLevel(1).length === 1, `exactly one accepted level-1 hint (got ${byLevel(1).length})`);
  check(byLevel(2).length === 1, `exactly one accepted level-2 hint (got ${byLevel(2).length})`);
  check(byLevel(3).length === 1, `exactly one accepted level-3 hint (got ${byLevel(3).length})`);
  check(hints.length === 3, `exactly 3 accepted hints total (got ${hints.length})`);

  for (const h of hints) {
    const g = checkHint(h.text);
    check(g.ok, `hint level ${h.level} passes the guard on re-check (${g.ok ? "ok" : g.reason})`);
    check(!hasCodeMarker(h.text), `hint level ${h.level} has no code marker`);
  }

  const WRITE_TOOLS = new Set(["editor", "apply_patch", "fetch_web_content", "skills", "submit_and_exit"]);
  const writeCalls = toolCalls.filter((t) => t.toolName && WRITE_TOOLS.has(t.toolName));
  check(
    writeCalls.length === 0,
    `no edit/write/network tool was executed (found ${writeCalls.map((t) => t.toolName).join(",") || "none"})`,
  );

  for (const a of approvals) {
    const cmds = Array.isArray(a.commands) ? a.commands : [];
    const localDecision = allowCommands(cmds);
    check(
      localDecision.allowed === a.allowed,
      `approval decision consistent for ${JSON.stringify(cmds)} (server said ${a.allowed})`,
    );
  }

  // --- report ---
  console.log("\n=== hints (verbatim) ===");
  for (const h of hints) {
    console.log(`\n[level ${h.level}${h.tag ? ` (${h.tag})` : ""}]`);
    console.log(h.text);
  }

  console.log("\n=== distinct SSE event types ===");
  console.log([...eventTypes].sort().join(", "));

  console.log("\n=== approval decisions ===");
  if (approvals.length === 0) {
    console.log("(none — the agent requested no command approvals during this run)");
  }
  for (const a of approvals) {
    console.log(`${a.allowed ? "APPROVED" : "DENIED"}  ${JSON.stringify(a.commands)}${a.reason ? `  (${a.reason})` : ""}`);
  }
}


// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log(`provider=${HINTLAB_PROVIDER_ID} model=${HINTLAB_MODEL_ID} port=${PORT}`);
  unitTestAllowList();
  unitTestHintGuard();

  const app = createApp();
  const server = app.listen(PORT);
  await new Promise<void>((resolve) => server.once("listening", resolve));

  const overallTimer = setTimeout(() => {
    console.error(`\nOVERALL TIMEOUT after ${OVERALL_TIMEOUT_MS}ms`);
    process.exit(1);
  }, OVERALL_TIMEOUT_MS);
  overallTimer.unref();

  try {
    await e2e();
  } finally {
    clearTimeout(overallTimer);
    server.close();
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
