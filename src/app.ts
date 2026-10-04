import fs from "node:fs";
import path from "node:path";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { isSlug, listAssignments, loadAssignment } from "./assignments";
import { nextHint, startSession } from "./agent";
import { HEARTBEAT_MS } from "./config";
import { sanitizeTestResults } from "./eventFilter";
import { runAssignment } from "./runner";
import {
  addClient,
  createSession,
  emitEvent,
  getSession,
  removeClient,
  setStatus,
} from "./sessions";
import { openSse, writeSseComment } from "./sse";
import type { Assignment } from "./types";

export function createApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/api/assignments", (_req, res) => {
    const assignments = listAssignments();
    res.json(
      assignments.map((a) => ({
        id: a.id,
        language: a.language,
        statement: a.statement,
        starterCode: a.starterCode,
      })),
    );
  });

  app.post("/api/session", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body: unknown = req.body;
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        res.status(400).json({ error: "request body must be a JSON object" });
        return;
      }

      const assignmentId = (body as Record<string, unknown>).assignmentId;
      if (!isSlug(assignmentId)) {
        res.status(400).json({ error: "assignmentId is required and must be a plain slug" });
        return;
      }

      let assignment: Assignment;
      try {
        assignment = loadAssignment(assignmentId);
      } catch {
        res.status(404).json({ error: `unknown assignment: ${assignmentId}` });
        return;
      }

      const codeRaw = (body as Record<string, unknown>).code;
      let code: string;
      if (codeRaw === undefined || codeRaw === null || codeRaw === "") {
        code = assignment.starterCode;
      } else if (typeof codeRaw !== "string") {
        res.status(400).json({ error: "code must be a string" });
        return;
      } else {
        code = codeRaw;
      }

      // Run the runner WITHOUT cleanup so the temp workdir persists for the
      // agent. The workdir is the agent's sandbox and lives until the session
      // ends/TTL, at which point the session cleanup loop removes it.
      const testResults = await runAssignment(assignment, code, { cleanup: false });

      const session = createSession({
        assignmentId: assignment.id,
        language: assignment.language,
        statement: assignment.statement,
        workdir: testResults.sandboxDir,
        testResults,
      });

      // Record the test results first so they replay before any agent event.
      emitEvent(session, "test_results", testResults);
      setStatus(session, "running");

      // Fire-and-forget: ask the agent for a level-1 hint in the background.
      startSession(session.id).catch((err) => {
        emitEvent(session, "error", { message: err instanceof Error ? err.message : String(err) });
        setStatus(session, "error");
      });

      res.json({ sessionId: session.id, testResults: sanitizeTestResults(testResults) });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/session/:id/stream", (req: Request, res: Response) => {
    const session = getSession(String(req.params.id));
    if (!session) {
      res.status(404).json({ error: "unknown session" });
      return;
    }

    openSse(res);
    res.write(": connected\n\n");
    addClient(session, res); // replays buffered events + registers for live events

    const heartbeat = setInterval(() => {
      try {
        writeSseComment(res, "ping");
      } catch {
        /* ignore */
      }
    }, HEARTBEAT_MS);
    heartbeat.unref();

    res.on("close", () => {
      clearInterval(heartbeat);
      removeClient(session, res);
    });
  });

  app.post("/api/session/:id/next-hint", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = getSession(String(req.params.id));
      if (!session) {
        res.status(404).json({ error: "unknown session" });
        return;
      }
      if (session.busy) {
        res.status(409).json({ error: "agent is still busy", status: session.status });
        return;
      }
      const result = await nextHint(session.id);
      res.json(result);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404) {
        res.status(404).json({ error: "unknown session" });
        return;
      }
      if (status === 409) {
        res.status(409).json({ error: "agent is still busy" });
        return;
      }
      next(err);
    }
  });

  const webDir = path.resolve(process.cwd(), "web");
  if (fs.existsSync(webDir)) {
    app.use(express.static(webDir));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = typeof err?.status === "number" ? err.status : 500;
    if (status >= 400 && status < 500) {
      res.status(status).json({ error: "invalid request body" });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "internal server error" });
  });

  return app;
}
