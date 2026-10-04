import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { isSlug, loadAssignment, listAssignments } from "./assignments";
import { PORT } from "./config";
import { runAssignment } from "./runner";
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

      const testResults = await runAssignment(assignment, code);
      const sessionId = randomUUID();

      res.json({ sessionId, testResults });
    } catch (err) {
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

export const app = createApp();

const isMainModule =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMainModule) {
  app.listen(PORT, () => {
    console.log(`HintLab server listening on http://localhost:${PORT}`);
  });
}
