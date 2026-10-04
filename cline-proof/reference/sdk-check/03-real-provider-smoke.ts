// TYPE-CHECKED ONLY on the box (no API key there). Run this tonight on your laptop with a real key:
//   PROVIDER_ID=anthropic MODEL_ID=<model> API_KEY=... node --experimental-strip-types 03-real-provider-smoke.ts
//   (or PROVIDER_ID=openai-compatible BASE_URL=https://.../v1 for OpenRouter/Groq/etc.)
// It copies ../fixtures/sum-of-list into a temp dir and asks the agent for ONE hint.
import { ClineCore, createTool } from "@cline/sdk"
import type { AgentTool } from "@cline/sdk"
import { z } from "zod"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const { PROVIDER_ID, MODEL_ID, API_KEY, BASE_URL } = process.env
if (!PROVIDER_ID || !MODEL_ID) throw new Error("set PROVIDER_ID and MODEL_ID (and API_KEY / BASE_URL as needed)")

const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "hintlab-"))
fs.cpSync(path.resolve("../fixtures/sum-of-list"), sandboxDir, { recursive: true })

const hints: unknown[] = []
const giveHint = createTool({
  name: "give_hint",
  description: "Show exactly one hint to the student. level 1 = nudge, 2 = where to look, 3 = concept. Never include corrected code.",
  inputSchema: z.object({ level: z.number().int().min(1).max(3), tag: z.string().describe("short mistake tag, e.g. off-by-one"), text: z.string() }),
  async execute(input) { hints.push(input); return { shown: true } },
})

const ALLOWED = [/^python3 main\.py( < [\w.-]+)?$/, /^(echo|printf) .* \| python3 main\.py$/, /^gcc [\w .-]+$/, /^\.\/main( < [\w.-]+)?$/, /^cat [\w.-]+$/]

const cline = await ClineCore.create({ clientName: "hintlab-smoke", backendMode: "local" })
cline.subscribe((e: any) => {
  const ev = e.type === "agent_event" ? e.payload?.event : undefined
  if (ev?.type === "content_start" && ev.contentType === "tool") console.log("→ tool", ev.toolName, JSON.stringify(ev.input))
  if (ev?.type === "content_end" && ev.contentType === "tool") console.log("← result", JSON.stringify(ev.output ?? ev.error).slice(0, 200))
})

const result = await cline.start({
  prompt: `Student code is at ${sandboxDir}/main.py. Tests are in ${sandboxDir}/tests.json. ` +
    `Run the code on the test inputs, find the root cause, then call give_hint once with level 1. Use absolute paths for read_files.`,
  config: {
    providerId: PROVIDER_ID, modelId: MODEL_ID, apiKey: API_KEY, baseUrl: BASE_URL,
    systemPrompt: "You are HintLab, a programming tutor. You may read files and run allow-listed commands. " +
      "You must never write or show corrected code. Deliver help only through the give_hint tool.",
    cwd: sandboxDir, workspaceRoot: sandboxDir,
    enableTools: true, enableSpawnAgent: false, enableAgentTeams: false,
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
      const ok = cmds.length > 0 && cmds.every((c) => ALLOWED.some((r) => r.test(c.trim())))
      console.log(ok ? "APPROVED" : "BLOCKED", cmds)
      return ok ? { approved: true } : { approved: false, reason: "Command not on the HintLab allow-list" }
    },
  },
})
console.log("finish:", (result.result as any)?.finishReason, "hints:", hints)
process.exit(0)
