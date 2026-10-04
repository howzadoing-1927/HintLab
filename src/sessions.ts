import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { Response } from "express";
import { SESSION_CLEANUP_INTERVAL_MS, SESSION_TTL_MS } from "./config";
import { writeSse } from "./sse";
import type { Hint, RunResult, Session, SessionEvent } from "./types";

/** In-memory session store, keyed by HintLab session id. */
const sessions = new Map<string, Session>();

/** Reverse index: SDK agent session id -> HintLab session id. */
const agentIdIndex = new Map<string, string>();

type StopAgentHook = (agentSessionId: string) => void;
let stopAgentHook: StopAgentHook | null = null;

/** agent.ts registers this so the cleanup loop can stop orphaned SDK sessions. */
export function setStopAgentHook(fn: StopAgentHook): void {
  stopAgentHook = fn;
}

export interface CreateSessionInput {
  assignmentId: string;
  language: "python" | "c";
  statement: string;
  workdir: string;
  testResults: RunResult;
}

export function createSession(input: CreateSessionInput): Session {
  const now = Date.now();
  const session: Session = {
    id: randomUUID(),
    assignmentId: input.assignmentId,
    language: input.language,
    statement: input.statement,
    workdir: input.workdir,
    testResults: input.testResults,
    hints: [],
    events: [],
    status: "created",
    busy: false,
    currentHintLevel: 1,
    sseClients: new Set(),
    createdAt: now,
    lastActiveAt: now,
  };
  sessions.set(session.id, session);
  return session;
}

/** Look up a session by HintLab id or by the SDK's agent session id. */
export function getSession(id: string): Session | undefined {
  const direct = sessions.get(id);
  if (direct) return direct;
  const hintlabId = agentIdIndex.get(id);
  return hintlabId ? sessions.get(hintlabId) : undefined;
}

export function registerAgentSession(agentSessionId: string, hintlabSessionId: string): void {
  agentIdIndex.set(agentSessionId, hintlabSessionId);
}

/** Record an event and broadcast it to every connected SSE client. */
export function emitEvent(session: Session, name: string, data: unknown): void {
  const event: SessionEvent = { name, data, at: Date.now() };
  session.events.push(event);
  session.lastActiveAt = Date.now();
  for (const res of session.sseClients) {
    try {
      writeSse(res, name, data);
    } catch {
      /* client already gone */
    }
  }
}

/** Set the session status (emits a `status` event on change). */
export function setStatus(session: Session, status: string): void {
  if (session.status === status) return;
  session.status = status;
  session.lastActiveAt = Date.now();
  emitEvent(session, "status", { status });
}

/** Register an SSE client and replay the buffered event history to it. */
export function addClient(session: Session, res: Response): void {
  session.sseClients.add(res);
  session.lastActiveAt = Date.now();
  // Replay is synchronous and single-threaded, so no event can be broadcast
  // between the snapshot below and the live broadcast that follows it.
  for (const event of session.events) {
    try {
      writeSse(res, event.name, event.data);
    } catch {
      break;
    }
  }
}

export function removeClient(session: Session, res: Response): void {
  session.sseClients.delete(res);
}

export function recordHint(session: Session, hint: Hint): void {
  session.hints.push(hint);
  session.lastActiveAt = Date.now();
  emitEvent(session, "hint", hint);
}

/** Remove a session, close its clients, and delete its temp workdir. */
export function deleteSession(id: string): void {
  const session = getSession(id);
  if (!session) return;
  sessions.delete(session.id);
  if (session.agentSessionId) agentIdIndex.delete(session.agentSessionId);

  for (const res of session.sseClients) {
    try {
      res.end();
    } catch {
      /* ignore */
    }
  }
  session.sseClients.clear();

  if (session.workdir) {
    try {
      fs.rmSync(session.workdir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }

  if (session.agentSessionId) {
    try {
      stopAgentHook?.(session.agentSessionId);
    } catch {
      /* ignore */
    }
  }
}

/** Start the TTL cleanup loop. Unref'd so it never keeps the process alive. */
export function startCleanupLoop(): void {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const session of [...sessions.values()]) {
      if (now - session.lastActiveAt > SESSION_TTL_MS) {
        deleteSession(session.id);
      }
    }
  }, SESSION_CLEANUP_INTERVAL_MS);
  timer.unref();
}
