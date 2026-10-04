import type { Response } from "express";

/** JSON.stringify that tolerates BigInt and non-serialisable values. */
function safeStringify(data: unknown): string {
  try {
    return JSON.stringify(data ?? null, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    );
  } catch {
    return JSON.stringify(null);
  }
}

/** Open a Server-Sent Events stream on the response. */
export function openSse(res: Response): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
}

/** Write a single named SSE event. */
export function writeSse(res: Response, name: string, data: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${name}\ndata: ${safeStringify(data)}\n\n`);
}

/** Write an SSE comment (used as a keep-alive heartbeat). */
export function writeSseComment(res: Response, comment: string): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`: ${comment}\n\n`);
}
