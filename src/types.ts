export type Language = "python" | "c";

export interface TestCase {
  name: string;
  input: string;
  expected: string;
}

export interface Assignment {
  /** Canonical slug id (the directory name under assignments/). */
  id: string;
  /** The assignmentId field from tests.json (matches the directory name for the fixtures). */
  assignmentId: string;
  language: Language;
  statement: string;
  build?: string;
  run: string;
  tests: TestCase[];
  /** The starter (buggy) program, read from main.py or main.c. */
  starterCode: string;
}

export interface BuildResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface TestResult {
  name: string;
  input: string;
  expected: string;
  got: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  passed: boolean;
}

export interface RunResult {
  assignmentId: string;
  sandboxDir: string;
  build: BuildResult | null;
  tests: TestResult[];
  passed: number;
  failed: number;
  total: number;
}

export interface RunnerOptions {
  runTimeoutMs?: number;
  buildTimeoutMs?: number;
  maxOutputBytes?: number;
  /** Remove the temp sandbox dir after the run completes. Defaults to false. */
  cleanup?: boolean;
}
