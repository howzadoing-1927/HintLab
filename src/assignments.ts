import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Assignment, Language, TestCase } from "./types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSIGNMENTS_DIR = path.resolve(__dirname, "..", "assignments");

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A "plain slug": lowercase letters/digits separated by single hyphens. No slashes, dots or "..". */
export function isSlug(id: unknown): id is string {
  return typeof id === "string" && SLUG_RE.test(id);
}

export function getAssignmentsDir(): string {
  return ASSIGNMENTS_DIR;
}

function validateAssignment(id: string, raw: unknown): Assignment {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`assignment ${id}: tests.json must be a JSON object`);
  }
  const obj = raw as Record<string, unknown>;

  const assignmentId = obj.assignmentId;
  if (typeof assignmentId !== "string" || assignmentId.length === 0) {
    throw new Error(`assignment ${id}: "assignmentId" must be a non-empty string`);
  }

  const language = obj.language;
  if (language !== "python" && language !== "c") {
    throw new Error(`assignment ${id}: "language" must be "python" or "c"`);
  }

  const statement = obj.statement;
  if (typeof statement !== "string" || statement.length === 0) {
    throw new Error(`assignment ${id}: "statement" must be a non-empty string`);
  }

  const run = obj.run;
  if (typeof run !== "string" || run.trim().length === 0) {
    throw new Error(`assignment ${id}: "run" must be a non-empty string`);
  }

  let build: string | undefined;
  if (obj.build !== undefined) {
    if (typeof obj.build !== "string" || obj.build.trim().length === 0) {
      throw new Error(`assignment ${id}: "build" must be a non-empty string when present`);
    }
    build = obj.build;
  }

  const tests = obj.tests;
  if (!Array.isArray(tests) || tests.length === 0) {
    throw new Error(`assignment ${id}: "tests" must be a non-empty array`);
  }

  const parsedTests: TestCase[] = tests.map((t, i) => {
    if (typeof t !== "object" || t === null || Array.isArray(t)) {
      throw new Error(`assignment ${id}: tests[${i}] must be an object`);
    }
    const tc = t as Record<string, unknown>;
    if (typeof tc.name !== "string" || tc.name.length === 0) {
      throw new Error(`assignment ${id}: tests[${i}].name must be a non-empty string`);
    }
    if (typeof tc.input !== "string") {
      throw new Error(`assignment ${id}: tests[${i}].input must be a string`);
    }
    if (typeof tc.expected !== "string") {
      throw new Error(`assignment ${id}: tests[${i}].expected must be a string`);
    }
    return { name: tc.name, input: tc.input, expected: tc.expected };
  });

  return {
    id,
    assignmentId,
    language: language as Language,
    statement,
    build,
    run,
    tests: parsedTests,
    starterCode: "",
  };
}

export function loadAssignment(id: string): Assignment {
  if (!isSlug(id)) {
    throw new Error(`invalid assignment id: ${JSON.stringify(id)}`);
  }

  const dir = path.join(ASSIGNMENTS_DIR, id);
  const testsJsonPath = path.join(dir, "tests.json");
  if (!fs.existsSync(testsJsonPath)) {
    throw new Error(`unknown assignment: ${id}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(testsJsonPath, "utf8"));
  } catch (err) {
    throw new Error(`assignment ${id}: failed to parse tests.json: ${(err as Error).message}`);
  }

  const assignment = validateAssignment(id, raw);

  const starterFile = assignment.language === "python" ? "main.py" : "main.c";
  const starterPath = path.join(dir, starterFile);
  if (!fs.existsSync(starterPath)) {
    throw new Error(`assignment ${id}: missing starter file ${starterFile}`);
  }
  assignment.starterCode = fs.readFileSync(starterPath, "utf8");

  return assignment;
}

export function listAssignments(): Assignment[] {
  if (!fs.existsSync(ASSIGNMENTS_DIR)) return [];

  const entries = fs.readdirSync(ASSIGNMENTS_DIR, { withFileTypes: true });
  const ids = entries
    .filter(
      (e) =>
        e.isDirectory() &&
        isSlug(e.name) &&
        fs.existsSync(path.join(ASSIGNMENTS_DIR, e.name, "tests.json")),
    )
    .map((e) => e.name)
    .sort();

  return ids.map((id) => loadAssignment(id));
}
