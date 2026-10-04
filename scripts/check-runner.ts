import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { loadAssignment } from "../src/assignments";
import { runAssignment } from "../src/runner";
import type { Assignment } from "../src/types";

const ASSIGNMENT_IDS = ["sum-of-list", "is-palindrome", "average-marks"];

// Expected results for the *buggy* starter programs (verified against the fixtures).
const buggyExpectations: Record<string, { name: string; got: string; passed: boolean }[]> = {
  "sum-of-list": [
    { name: "basic", got: "5", passed: false },
    { name: "single", got: "0", passed: false },
    { name: "negatives", got: "9", passed: false },
    { name: "first-only-big", got: "1", passed: false },
  ],
  "is-palindrome": [
    { name: "simple", got: "YES", passed: true },
    { name: "not", got: "NO", passed: true },
    { name: "mixed-case", got: "NO", passed: false },
    { name: "spaces", got: "NO", passed: false },
  ],
  "average-marks": [
    { name: "even", got: "15.00", passed: true },
    { name: "fraction", got: "1.00", passed: false },
    { name: "half", got: "3.00", passed: false },
  ],
};

const expectedPassCount: Record<string, number> = {
  "sum-of-list": 0,
  "is-palindrome": 2,
  "average-marks": 1,
};

// Correct solutions, written inline to prove the runner can pass (not only fail).
const correctSolutions: Record<string, string> = {
  "sum-of-list": "nums = list(map(int, input().split()))\nprint(sum(nums))\n",
  "is-palindrome":
    "s = input()\nt = s.lower().replace(' ', '')\nprint('YES' if t == t[::-1] else 'NO')\n",
  "average-marks":
    "#include <stdio.h>\nint main(void) {\n    int n, sum = 0, x;\n    scanf(\"%d\", &n);\n    for (int i = 0; i < n; i++) { scanf(\"%d\", &x); sum += x; }\n    printf(\"%.2f\\n\", (float)sum / n);\n    return 0;\n}\n",
};

const infiniteLoop = "while True:\n    pass\n";

const badC = "int main(void) {\n    this is not valid C\n}\n";

let failures = 0;

function check(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  PASS  ${msg}`);
  } else {
    console.error(`  FAIL  ${msg}`);
    failures += 1;
  }
}

/** Build a minimal Python assignment for targeted runner checks. */
function pythonAssignment(id: string, expected: string): Assignment {
  return {
    id,
    assignmentId: id,
    language: "python",
    statement: "",
    run: "python3 main.py",
    tests: [{ name: "single", input: "", expected }],
    starterCode: "",
  };
}

/** Build a minimal C assignment (gcc build + ./main) for targeted checks. */
function cAssignment(id: string, expected: string): Assignment {
  return {
    id,
    assignmentId: id,
    language: "c",
    statement: "",
    build: "gcc -Wall -O0 main.c -o main",
    run: "./main",
    tests: [{ name: "single", input: "", expected }],
    starterCode: "",
  };
}

/** Names of the runner's temp sandbox dirs currently under os.tmpdir(). */
function hintlabTempDirs(): string[] {
  return fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("hintlab-"));
}

/** PIDs whose command line matches the given `pgrep -f` pattern. */
function pidsMatching(pattern: string): string[] {
  try {
    return execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return []; // pgrep exits non-zero when nothing matches
  }
}

/** Poll until no process matches the pattern (confirms the group was reaped). */
async function waitUntilNoPids(pattern: string, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pidsMatching(pattern).length === 0) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return pidsMatching(pattern).length === 0;
}

interface TableResult {
  build: { ok: boolean; stderr: string } | null;
  tests: { name: string; expected: string; got: string; timedOut: boolean; passed: boolean }[];
  passed: number;
  total: number;
}

function printTestTable(id: string, assignment: Assignment, result: TableResult): void {
  console.log(`\n=== ${id} (${assignment.language}) ===`);
  if (result.build) {
    console.log(`  build: ${result.build.ok ? "ok" : "FAILED"}`);
    if (!result.build.ok && result.build.stderr.trim()) {
      console.log(`  build stderr: ${result.build.stderr.trim().split("\n")[0]}`);
    }
  } else {
    console.log(`  build: none`);
  }
  for (const t of result.tests) {
    const tag = t.timedOut ? "TIMEOUT" : t.passed ? "PASS" : "FAIL";
    console.log(
      `  [${tag.padEnd(7)}] ${t.name.padEnd(16)} expected=${JSON.stringify(t.expected).padEnd(8)} got=${JSON.stringify(t.got).padEnd(8)}`,
    );
  }
  console.log(`  -> ${result.passed}/${result.total} passed`);
}

async function main(): Promise<void> {
  // Snapshot the runner's temp dirs up front so the cleanup check (below) can
  // detect any new dirs leaked by the checks in this script.
  const baselineDirs = new Set(hintlabTempDirs());

  // 1. Buggy starter programs must fail exactly as expected.
  for (const id of ASSIGNMENT_IDS) {
    const assignment = loadAssignment(id);
    const result = await runAssignment(assignment, assignment.starterCode, { cleanup: true });
    printTestTable(id, assignment, result);

    const exp = buggyExpectations[id];
    check(result.tests.length === exp.length, `${id}: ${exp.length} tests ran`);
    for (let i = 0; i < exp.length; i++) {
      const t = result.tests[i];
      if (!t) {
        check(false, `${id}: missing test result #${i}`);
        continue;
      }
      check(t.got === exp[i].got, `${id}/${t.name}: got=${JSON.stringify(t.got)} (expected ${JSON.stringify(exp[i].got)})`);
      check(t.passed === exp[i].passed, `${id}/${t.name}: passed=${t.passed} (expected ${exp[i].passed})`);
    }
    check(result.passed === expectedPassCount[id], `${id}: ${result.passed}/${result.total} passed (expected ${expectedPassCount[id]})`);
  }

  // 2. Correct solutions must pass every test.
  for (const id of ASSIGNMENT_IDS) {
    const assignment = loadAssignment(id);
    const result = await runAssignment(assignment, correctSolutions[id], { cleanup: true });
    console.log(`\n=== ${id} (correct solution) ===`);
    for (const t of result.tests) {
      console.log(`  [${t.passed ? "PASS" : "FAIL"}] ${t.name} got=${JSON.stringify(t.got)}`);
    }
    if (result.build && !result.build.ok) {
      check(false, `${id} correct solution build failed: ${result.build.stderr}`);
    }
    check(result.total > 0 && result.passed === result.total, `${id} correct solution passes all ${result.total} tests`);
  }

  // 3. Infinite loop must be reported as timed out.
  {
    const assignment = loadAssignment("sum-of-list");
    const result = await runAssignment(assignment, infiniteLoop, { cleanup: true, runTimeoutMs: 1000 });
    console.log(`\n=== infinite loop (sum-of-list) ===`);
    for (const t of result.tests) {
      console.log(`  [${t.timedOut ? "TIMEOUT" : "no-timeout"}] ${t.name}`);
    }
    check(result.total > 0, "infinite loop ran at least one test");
    check(result.tests.every((t) => t.timedOut && !t.passed), "infinite loop: every test timed out and failed");
  }

  // 4. C program with a compile error must be reported as a build failure.
  {
    const assignment = loadAssignment("average-marks");
    const result = await runAssignment(assignment, badC, { cleanup: true });
    console.log(`\n=== C compile error (average-marks) ===`);
    const stderr = (result.build?.stderr ?? "").trim();
    console.log(`  build.ok=${result.build?.ok} timedOut=${result.build?.timedOut}`);
    if (stderr) console.log(`  stderr (first line): ${stderr.split("\n")[0]}`);
    check(result.build !== null, "compile error: build step ran");
    check(result.build !== null && result.build.ok === false, "compile error: build reported failure");
    check(result.build !== null && /error/.test(result.build.stderr), "compile error: stderr contains 'error'");
    check(result.total === 0, "compile error: no tests ran (total 0)");
  }

  // 5. Process group cleanup: a program that orphans a child must not leave it alive.
  {
    console.log("\n=== process group cleanup ===");
    // A unique duration so `pgrep -f` cannot collide with an unrelated `sleep`.
    const sleepSeconds = 987654;
    const assignment = pythonAssignment("proc-group-check", "6");
    const code = `import subprocess\nsubprocess.Popen(['sleep', '${sleepSeconds}'])\nprint(6)\n`;
    const result = await runAssignment(assignment, code, { cleanup: true });
    check(result.tests.length === 1 && result.tests[0]?.got === "6", "spawner program ran and printed 6");
    const reaped = await waitUntilNoPids(`sleep ${sleepSeconds}`);
    check(reaped, `no stray 'sleep ${sleepSeconds}' process left behind after the run`);
  }

  // 6. A program killed by a signal must report that signal (not empty stderr).
  {
    console.log("\n=== signal (SIGSEGV) ===");
    const assignment = cAssignment("sigsegv-check", "");
    const code = "#include <stddef.h>\nint main(void) {\n    volatile int *p = NULL;\n    *p = 42;\n    return 0;\n}\n";
    const result = await runAssignment(assignment, code, { cleanup: true });
    check(result.build !== null && result.build.ok === true, "segfault program compiles");
    check(result.tests.length === 1, "segfault program ran one test");
    const t = result.tests[0];
    if (!t) {
      check(false, "segfault test result missing");
    } else {
      check(t.signal === "SIGSEGV", `segfault reported signal SIGSEGV (got ${t.signal ?? "null"})`);
      check(t.passed === false, "segfault test failed");
      check(t.exitCode === null, "segfault exitCode is null");
      check(/Program terminated by signal SIGSEGV/.test(t.stderr), "segfault stderr explains the signal");
    }
  }

  // 7. Minimal environment: student code must not see the server's env vars.
  {
    console.log("\n=== minimal environment ===");
    process.env.HINTLAB_FAKE_SECRET = "leak-test";
    const assignment = pythonAssignment("env-check", "");
    const code =
      "import os\n" +
      "print('\\n'.join(sorted(os.environ.keys())))\n" +
      "print('HOME=' + os.environ.get('HOME', ''))\n";
    const result = await runAssignment(assignment, code, { cleanup: true });
    delete process.env.HINTLAB_FAKE_SECRET;

    check(result.tests.length === 1, "env program ran one test");
    const got = result.tests[0]?.got ?? "";
    check(!got.includes("HINTLAB_FAKE_SECRET"), "fake secret did not leak into student code");

    const lines = got.split("\n");
    const keys = lines.filter((l) => l && !l.startsWith("HOME="));
    const homeLine = lines.find((l) => l.startsWith("HOME="));

    // macOS injects __CF_USER_TEXT_ENCODING into every process even when given
    // an explicit env (CFUserTextEncoding); it carries no secret, so allow it.
    const allowed = new Set(["PATH", "HOME", "LANG", "__CF_USER_TEXT_ENCODING"]);
    const unexpected = keys.filter((k) => !allowed.has(k));
    check(unexpected.length === 0, `only allowed env keys present (unexpected: ${unexpected.join(", ") || "none"})`);
    check(keys.includes("PATH") && keys.includes("HOME") && keys.includes("LANG"), "PATH/HOME/LANG are present");
    check(homeLine === `HOME=${result.sandboxDir}`, `HOME equals the run's temp dir (got ${homeLine})`);
  }

  // 8. Temp dir cleanup: no hintlab-* dirs may be left behind by any run above.
  {
    console.log("\n=== temp dir cleanup ===");
    const leaked = hintlabTempDirs().filter((d) => !baselineDirs.has(d));
    check(leaked.length === 0, `no hintlab temp dirs left behind (leaked: ${leaked.join(", ") || "none"})`);
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

