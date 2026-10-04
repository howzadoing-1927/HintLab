import type { Response } from "express";

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
  /** Signal that killed the build process (e.g. "SIGKILL"), or null. */
  signal: string | null;
}

export interface TestResult {
  name: string;
  input: string;
  expected: string;
  got: string;
  stderr: string;
  exitCode: number | null;
  /** Signal that killed the program (e.g. "SIGSEGV"), or null. */
  signal: string | null;
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
  /**
   * Remove the temp sandbox dir after the run completes (success, failure,
   * timeout, build failure, or exception). Defaults to true. Pass `false`
   * only when something needs the dir afterwards — the agent session's
   * workdir is the one such case, and it is removed later by the session
   * TTL cleanup.
   */
  cleanup?: boolean;
}

export type HintLevel = 1 | 2 | 3;

/** A single hint delivered to the student via the give_hint tool (already guarded). */
export interface Hint {
  level: HintLevel;
  tag?: string;
  text: string;
  at: string;
}

/** A recorded SSE event that can be replayed to late-joining clients. */
export interface SessionEvent {
  name: string;
  data: unknown;
  at: number;
}

/** In-memory session record. */
export interface Session {
  id: string;
  assignmentId: string;
  language: Language;
  statement: string;
  /** Temp workdir containing main.py/main.c + tests.json (owned by the runner). */
  workdir: string;
  testResults: RunResult;
  hints: Hint[];
  events: SessionEvent[];
  status: string;
  /** True while an agent turn (start/send) is in flight. */
  busy: boolean;
  /** The hint level the server is currently asking the agent for. */
  currentHintLevel: number;
  /** The SDK session id (equals this.id since we pass config.sessionId). */
  agentSessionId?: string;
  /** Set once an auth failure has been logged/emitted for this session (dedupe). */
  authFailureHandled?: boolean;
  sseClients: Set<Response>;
  createdAt: number;
  lastActiveAt: number;
}
