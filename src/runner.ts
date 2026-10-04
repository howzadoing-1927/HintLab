import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BUILD_TIMEOUT_MS, MAX_OUTPUT_BYTES, RUN_TIMEOUT_MS } from "./config";
import type { Assignment, BuildResult, RunResult, RunnerOptions, TestResult } from "./types";

interface SpawnOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
}

interface SpawnConfig {
  cwd: string;
  input?: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

/**
 * Split a command string into argv without invoking a shell. Supports single/
 * double quotes and backslash escapes, but the fixtures only use simple,
 * whitespace-separated commands ("python3 main.py", "gcc -Wall -O0 main.c -o main", "./main").
 */
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "\\" && i + 1 < command.length) {
      current += command[i + 1];
      i += 1;
    } else if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }

  if (current) tokens.push(current);
  return tokens;
}

/**
 * Minimal environment handed to the student program and the gcc build. Only
 * PATH (so python3/gcc are still found), HOME (pointed at the run's temp dir),
 * and LANG are set. The server's process.env is deliberately NOT inherited, so
 * ClinePass/SDK credentials or any other server env var can never leak into
 * student code.
 */
function minimalEnv(home: string): NodeJS.ProcessEnv {
  const pathEnv = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  return {
    PATH: pathEnv,
    HOME: home,
    LANG: "C.UTF-8",
  };
}

/** Human-readable description for common fatal signals (used in stderr). */
const SIGNAL_DESCRIPTIONS: Record<string, string> = {
  SIGSEGV: "segmentation fault",
  SIGABRT: "aborted",
  SIGFPE: "floating point exception",
  SIGILL: "illegal instruction",
  SIGBUS: "bus error",
  SIGTRAP: "trace/breakpoint trap",
  SIGSYS: "bad system call",
};

function describeSignal(signal: string): string {
  const desc = SIGNAL_DESCRIPTIONS[signal];
  return desc ? ` (${desc})` : "";
}

function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    // detached:true makes the child its own process-group leader on POSIX,
    // so killing the group reaps any grandchildren too.
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

function spawnCommand(command: string, config: SpawnConfig): Promise<SpawnOutcome> {
  const tokens = tokenize(command);
  if (tokens.length === 0) {
    return Promise.resolve({ stdout: "", stderr: "empty command", exitCode: null, signal: null, timedOut: false });
  }

  const [cmd, ...args] = tokens;

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let exitCode: number | null = null;
    let signal: string | null = null;
    let timedOut = false;
    let settled = false;

    const child = spawn(cmd, args, {
      cwd: config.cwd,
      env: minimalEnv(config.cwd),
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (target === "stdout") {
        const space = config.maxOutputBytes - stdout.length;
        if (space > 0) stdout += text.slice(0, space);
      } else {
        const space = config.maxOutputBytes - stderr.length;
        if (space > 0) stderr += text.slice(0, space);
      }
    };

    // Kill the whole process group exactly once, no matter how the run ends
    // (normal exit, spawn error, timeout, ...). detached:true made the child its
    // own group leader on POSIX, so this also reaps any grandchildren it forked
    // (e.g. a `subprocess.Popen(['sleep','31'])` that would otherwise survive).
    let killed = false;
    const killGroup = () => {
      if (killed) return;
      killed = true;
      killProcessTree(child);
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killGroup();
      resolve({ stdout, stderr, exitCode, signal, timedOut });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      finish();
    }, config.timeoutMs);

    child.stdout?.on("data", (d: Buffer) => append("stdout", d));
    child.stderr?.on("data", (d: Buffer) => append("stderr", d));

    child.once("error", (err) => {
      stderr += `\n[runner] failed to spawn '${cmd}': ${err.message}`;
      finish();
    });

    child.once("exit", (code, sig) => {
      exitCode = code;
      // Our own timeout SIGKILL is not a crash: it is already reported via
      // `timedOut`, so only record a signal when the program died on its own.
      if (sig && !timedOut) {
        signal = sig;
        stderr += `\n[runner] Program terminated by signal ${sig}${describeSignal(sig)}\n`;
      }
      finish();
    });

    child.stdin?.on("error", () => {
      /* ignore EPIPE if the process exited before reading stdin */
    });

    if (config.input !== undefined) {
      child.stdin?.write(config.input);
    }
    child.stdin?.end();
  });
}

export function cleanupSandbox(sandboxDir: string): void {
  try {
    fs.rmSync(sandboxDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
}

/** A safe file-safe slug for a test name: lowercase alphanumerics and hyphens. */
export function slugifyTestName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Result of running tests inside an already-created workdir. */
export interface RunInWorkdirResult {
  build: BuildResult | null;
  tests: TestResult[];
  passed: number;
  failed: number;
  total: number;
}

/**
 * Run the assignment's build (if any) and test cases against the code that is
 * already present in `workdir` (the agent's sandbox). Uses the same hardened
 * `spawnCommand` path as `runAssignment` — process-group kill, per-test timeouts,
 * and a minimal env with HOME set to the temp dir — so student code run by the
 * agent can never read server env vars or credentials. Returns per-test input,
 * expected, got, stderr, signal and pass/fail.
 */
export async function runTestsInWorkdir(
  assignment: Assignment,
  workdir: string,
  testName?: string,
): Promise<RunInWorkdirResult> {
  let build: BuildResult | null = null;
  if (assignment.build) {
    const b = await spawnCommand(assignment.build, {
      cwd: workdir,
      timeoutMs: BUILD_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    });
    build = {
      ok: !b.timedOut && b.exitCode === 0,
      stdout: b.stdout,
      stderr: b.stderr,
      timedOut: b.timedOut,
      signal: b.signal,
    };
    if (!build.ok) {
      return { build, tests: [], passed: 0, failed: 0, total: 0 };
    }
  }

  const slug = testName ? slugifyTestName(testName) : undefined;
  const toRun = slug ? assignment.tests.filter((t) => slugifyTestName(t.name) === slug) : assignment.tests;

  const tests: TestResult[] = [];
  for (const test of toRun) {
    const r = await spawnCommand(assignment.run, {
      cwd: workdir,
      input: test.input,
      timeoutMs: RUN_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    });
    const got = r.stdout.trim();
    const passed = !r.timedOut && r.exitCode === 0 && got === test.expected;
    tests.push({
      name: test.name,
      input: test.input,
      expected: test.expected,
      got,
      stderr: r.stderr,
      exitCode: r.exitCode,
      signal: r.signal,
      timedOut: r.timedOut,
      passed,
    });
  }

  const passed = tests.filter((t) => t.passed).length;
  return {
    build,
    tests,
    passed,
    failed: tests.length - passed,
    total: tests.length,
  };
}

export async function runAssignment(
  assignment: Assignment,
  code: string,
  options: RunnerOptions = {},
): Promise<RunResult> {
  const runTimeoutMs = options.runTimeoutMs ?? RUN_TIMEOUT_MS;
  const buildTimeoutMs = options.buildTimeoutMs ?? BUILD_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  // Clean up the temp sandbox dir by default (success, failure, timeout, build
  // failure, or exception). Only the agent session opts out via { cleanup: false }
  // because its workdir must outlive the run (it is removed later at TTL).
  const cleanup = options.cleanup ?? true;

  const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "hintlab-"));
  const sourceFile = assignment.language === "python" ? "main.py" : "main.c";

  try {
    fs.writeFileSync(path.join(sandboxDir, sourceFile), code, "utf8");
    fs.writeFileSync(
      path.join(sandboxDir, "tests.json"),
      JSON.stringify(
        {
          assignmentId: assignment.assignmentId,
          language: assignment.language,
          statement: assignment.statement,
          ...(assignment.build ? { build: assignment.build } : {}),
          run: assignment.run,
          tests: assignment.tests,
        },
        null,
        2,
      ),
      "utf8",
    );

    // Write each test's input to its own file (input-<test-name>.txt) so the
    // agent can feed the program via a stdin redirect from that file name when
    // it needs to, without ever constructing an echo/printf pipe.
    for (const test of assignment.tests) {
      fs.writeFileSync(
        path.join(sandboxDir, `input-${slugifyTestName(test.name)}.txt`),
        test.input,
        "utf8",
      );
    }

    let build: BuildResult | null = null;
    if (assignment.build) {
      const b = await spawnCommand(assignment.build, {
        cwd: sandboxDir,
        timeoutMs: buildTimeoutMs,
        maxOutputBytes,
      });
      build = {
        ok: !b.timedOut && b.exitCode === 0,
        stdout: b.stdout,
        stderr: b.stderr,
        timedOut: b.timedOut,
        signal: b.signal,
      };

      if (!build.ok) {
        return {
          assignmentId: assignment.id,
          sandboxDir,
          build,
          tests: [],
          passed: 0,
          failed: 0,
          total: 0,
        };
      }
    }

    const tests: TestResult[] = [];
    for (const test of assignment.tests) {
      const r = await spawnCommand(assignment.run, {
        cwd: sandboxDir,
        input: test.input,
        timeoutMs: runTimeoutMs,
        maxOutputBytes,
      });
      const got = r.stdout.trim();
      const passed = !r.timedOut && r.exitCode === 0 && got === test.expected;
      tests.push({
        name: test.name,
        input: test.input,
        expected: test.expected,
        got,
        stderr: r.stderr,
        exitCode: r.exitCode,
        signal: r.signal,
        timedOut: r.timedOut,
        passed,
      });
    }

    const passed = tests.filter((t) => t.passed).length;

    return {
      assignmentId: assignment.id,
      sandboxDir,
      build,
      tests,
      passed,
      failed: tests.length - passed,
      total: tests.length,
    };
  } finally {
    if (cleanup) cleanupSandbox(sandboxDir);
  }
}

