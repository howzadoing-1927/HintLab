# sdk-check: what was run on the box (3 Oct 2026, ~21:30 IST)

Environment: Node v22.23.3, @cline/sdk 0.0.90, zod 4, TypeScript 5.9 (`moduleResolution: Bundler`).
Run any file with `node --experimental-strip-types --no-warnings <file>.ts`.

| File | Status | What it shows |
|---|---|---|
| 01-agent-mock.ts | RAN (scripted fake model, no key) | `Agent` + `createTool` + `toolPolicies` + `requestToolApproval` + `subscribe`. A disabled tool is blocked when called but still listed to the model. |
| 02-clinecore-mock.ts + mock-openai.ts | RAN (fake OpenAI-compatible server, no key) | `ClineCore` session with built-in tools: edit tools removed from the model's tool list, `run_commands` approved/blocked by allow-list, `extraTools` custom tool executes, `subscribe` events, custom `sessionId`, `interactive: true` + `send()` follow-up. Run it from inside `ws/` with `MOCK_READ_PATH=main.py`. |
| 03-real-provider-smoke.ts | TYPED; RAN against the fake server only | The script to run tonight with a real key (see prep-sheet section 2.5). |
