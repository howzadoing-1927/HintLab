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
    return Promise.resolve({ stdout: "", stderr: "empty command", exitCode: null, timedOut: false });
  }

  const [cmd, ...args] = tokens;

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let exitCode: number | null = null;
    let timedOut = false;
    let settled = false;

    const child = spawn(cmd, args, {
      cwd: config.cwd,
      env: process.env,
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

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, timedOut });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
      finish();
    }, config.timeoutMs);

    child.stdout?.on("data", (d: Buffer) => append("stdout", d));
    child.stderr?.on("data", (d: Buffer) => append("stderr", d));

    child.once("error", (err) => {
      stderr += `\n[runner] failed to spawn '${cmd}': ${err.message}`;
      finish();
    });

    child.once("exit", (code) => {
      exitCode = code;
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

export async function runAssignment(
  assignment: Assignment,
  code: string,
  options: RunnerOptions = {},
): Promise<RunResult> {
  const runTimeoutMs = options.runTimeoutMs ?? RUN_TIMEOUT_MS;
  const buildTimeoutMs = options.buildTimeoutMs ?? BUILD_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;

  const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "hintlab-"));
  const sourceFile = assignment.language === "python" ? "main.py" : "main.c";

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
    };

    if (!build.ok) {
      if (options.cleanup) cleanupSandbox(sandboxDir);
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
      timedOut: r.timedOut,
      passed,
    });
  }

  const passed = tests.filter((t) => t.passed).length;

  if (options.cleanup) cleanupSandbox(sandboxDir);

  return {
    assignmentId: assignment.id,
    sandboxDir,
    build,
    tests,
    passed,
    failed: tests.length - passed,
    total: tests.length,
  };
}

