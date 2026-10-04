// RUNS WITHOUT AN API KEY: real ClineCore session against a local fake OpenAI-compatible server.
import { ClineCore, createTool } from "@cline/sdk"
import type { AgentTool } from "@cline/sdk"
import { z } from "zod"
import path from "node:path"
import { startMock, log } from "./mock-openai.ts"

const server = startMock(18555)
const sandboxDir = path.resolve("ws")

const giveHint = createTool({
  name: "give_hint",
  description: "Show one hint to the student. level 1 nudge, 2 location, 3 concept. Never include corrected code.",
  inputSchema: z.object({ level: z.number().int().min(1).max(3), tag: z.string(), text: z.string() }),
  async execute(input) { console.log("HINT:", input); return { shown: true } },
})

const ALLOWED = [/^echo .* \| python3 main\.py$/, /^python3 main\.py( < [\w.]+)?$/, /^gcc main\.c -o main$/, /^\.\/main( < [\w.]+)?$/]
const approvals: string[] = []
const eventTypes = new Set<string>()
const cline = await ClineCore.create({ clientName: "hintlab-check", backendMode: "local" })
const unsub = cline.subscribe((e: any) => {
  if (e.type === "agent_event" && ["content_start","content_end"].includes(e.payload?.event?.type)) {
    const ev = e.payload.event
    if (ev.contentType === "tool") console.log("\nTOOL", ev.type, ev.toolName, JSON.stringify(ev.input ?? ev.output ?? ev.error ?? "").slice(0, 160))
  }
  eventTypes.add(e.type === "agent_event" ? "agent_event:" + e.payload?.event?.type : e.type)
})

const session = await cline.start({
  interactive: true,
  prompt: "Debug main.py for assignment sum-of-list. Expected output for '1 2 3' is 6.",
  config: {
    sessionId: "hintlab-test-" + Date.now(),
    providerId: "openai-compatible",
    modelId: "mock-model",
    apiKey: "not-a-real-key",
    baseUrl: "http://127.0.0.1:18555/v1",
    systemPrompt: "You are HintLab. Diagnose, then call give_hint. Never write corrected code.",
    cwd: sandboxDir,
    workspaceRoot: sandboxDir,
    enableTools: true,
    enableSpawnAgent: false,
    enableAgentTeams: false,
    extraTools: [giveHint as unknown as AgentTool],
  },
  toolPolicies: {
    read_files: { autoApprove: true },
    search_codebase: { autoApprove: true },
    run_commands: { autoApprove: false },
    editor: { enabled: false },
    apply_patch: { enabled: false },
    fetch_web_content: { enabled: false },
    give_hint: { autoApprove: true },
  },
  capabilities: {
    requestToolApproval: async (req) => {
      const cmds: string[] = ((req.input as any)?.commands ?? []).map((c: any) => (typeof c === "string" ? c : c.command))
      const ok = cmds.length > 0 && cmds.every((c) => ALLOWED.some((r) => r.test(c)))
      approvals.push(`${req.toolName} ${JSON.stringify(cmds)} -> ${ok}`)
      return ok ? { approved: true } : { approved: false, reason: "Command not on the HintLab allow-list" }
    },
  },
})
console.log("\nsessionId:", session.sessionId, "finish:", (session.result as any)?.finishReason ?? (session.result as any)?.status)
console.log("approvals:", approvals)
console.log("event types:", [...eventTypes].join(", "))
try {
  const r2: any = await cline.send({ sessionId: session.sessionId, prompt: "Student is still stuck. Give the next hint level." })
  console.log("send() ok:", r2?.finishReason ?? r2?.status ?? Object.keys(r2 ?? {}))
} catch (err) { console.log("send() failed:", (err as Error).message) }
unsub()
server.close()
process.exit(0)
