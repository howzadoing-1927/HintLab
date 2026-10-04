// RUNS WITHOUT AN API KEY: scripted fake model drives the real Cline SDK agent loop.
import { Agent, createTool } from "@cline/sdk"
import type { AgentModel, AgentModelRequest } from "@cline/agents"
import { z } from "zod"

const giveHint = createTool({
  name: "give_hint",
  description: "Give the student one hint at the given level (1 nudge, 2 location, 3 concept). Never include corrected code.",
  inputSchema: z.object({ level: z.number().int().min(1).max(3), tag: z.string(), text: z.string() }),
  async execute(input) { return { shown: true, ...input } },
})
const runTests = createTool({
  name: "run_tests",
  description: "Run the assignment test cases against the student's submission.",
  inputSchema: z.object({ assignmentId: z.string() }),
  async execute(input) { return { assignmentId: input.assignmentId, passed: 2, failed: 1 } },
})
const editFile = createTool({
  name: "edit_file",
  description: "Edit a file (must be disabled in HintLab).",
  inputSchema: z.object({ path: z.string(), content: z.string() }),
  async execute() { editExecuted = true; return { edited: true } },
})

let call = 0
const seenToolNames: string[][] = []
const model: AgentModel = {
  async *stream(req: AgentModelRequest) {
    seenToolNames.push(req.tools.map((t) => t.name))
    call++
    if (call === 1) {
      yield { type: "text-delta", text: "Running tests first. " }
      yield { type: "tool-call-delta", toolCallId: "c1", toolName: "run_tests", input: { assignmentId: "sum-of-list" } }
      yield { type: "finish", reason: "tool-calls" }
    } else if (call === 2) {
      yield { type: "tool-call-delta", toolCallId: "cx", toolName: "edit_file", input: { path: "main.py", content: "fixed" } }
      yield { type: "finish", reason: "tool-calls" }
    } else if (call === 3) {
      yield { type: "tool-call-delta", toolCallId: "c2", toolName: "give_hint", input: { level: 1, tag: "off-by-one", text: "Check which indices your loop visits." } }
      yield { type: "finish", reason: "tool-calls" }
    } else {
      yield { type: "text-delta", text: "Done." }
      yield { type: "finish", reason: "stop" }
    }
  },
}

const approvals: string[] = []
const agent = new Agent({
  model,
  systemPrompt: "You are HintLab.",
  tools: [runTests, giveHint, editFile],
  toolPolicies: {
    edit_file: { enabled: false },
    run_tests: { autoApprove: false },
    give_hint: { autoApprove: true },
  },
  requestToolApproval: async (req) => {
    approvals.push(`${req.toolName} ${JSON.stringify(req.input)}`)
    return { approved: req.toolName === "run_tests" }
  },
})

const events: string[] = []
let editExecuted = false
agent.subscribe((e) => {
  events.push(e.type)
  if (e.type === "tool-finished") console.log("tool-finished:", e.toolCall.toolName, JSON.stringify(e.message.content).slice(0, 200))
})

const result = await agent.run("Debug submission for sum-of-list")
console.log("status:", result.status, "iterations:", result.iterations, "output:", JSON.stringify(result.outputText))
console.log("tools model saw per call:", JSON.stringify(seenToolNames))
console.log("approval requests:", approvals)
console.log("edit_file executed?", editExecuted)
console.log("event types:", [...new Set(events)].join(", "))
