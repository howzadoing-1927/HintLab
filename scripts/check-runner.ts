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

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

