// Tiny fake OpenAI-compatible /chat/completions server (streaming) used only to exercise ClineCore without an API key.
import http from "node:http"
let n = 0
export const log: string[] = []
function sse(res: http.ServerResponse, chunks: any[]) {
  res.writeHead(200, { "content-type": "text/event-stream" })
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`)
  res.end("data: [DONE]\n\n")
}
const base = (delta: any, finish: string | null = null) => ({ id: "x", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta, finish_reason: finish }] })
const toolCall = (id: string, name: string, args: any) => [
  base({ role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }),
  base({}, "tool_calls"),
]
export function startMock(port: number) {
  return http.createServer((req, res) => {
    let body = ""
    req.on("data", (d) => (body += d))
    req.on("end", () => {
      log.push(`${req.method} ${req.url}`)
      if (!req.url?.includes("chat/completions")) { res.writeHead(404); return res.end() }
      const j = JSON.parse(body)
      log.push("tools offered: " + (j.tools ?? []).map((t: any) => t.function?.name).join(","))
      n++
      if (n === 1) return sse(res, toolCall("c1", "read_files", { files: [{ path: process.env.MOCK_READ_PATH ?? "main.py" }] }))
      if (n === 2) return sse(res, toolCall("c2", "run_commands", { commands: ["echo 1 2 3 | python3 main.py"] }))
      if (n === 3) return sse(res, toolCall("c3", "run_commands", { commands: ["rm -rf /tmp/should-not-run"] }))
      if (n === 4) return sse(res, toolCall("c4", "give_hint", { level: 1, tag: "off-by-one", text: "Which index does your loop start from?" }))
      return sse(res, [base({ role: "assistant", content: "Hint delivered." }), base({}, "stop")])
    })
  }).listen(port)
}
