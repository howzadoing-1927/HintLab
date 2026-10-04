# Cline prompt 00: plan
Sent: 2026-10-04 12:20:25 IST
Mode: plan (cline -p --json --thinking medium -c /Users/prakharagarwal/ClineHackathon)
---
You are planning a hackathon project called HintLab in this repo (/Users/prakharagarwal/ClineHackathon). Do not write any code yet. Produce a step-by-step build plan.

First read everything under cline-proof/reference/:
- cline-proof/reference/fixtures/: three buggy student programs (sum-of-list/main.py, is-palindrome/main.py, average-marks/main.c), each with a tests.json (assignmentId, language, statement, optional build command, run command, and tests with input/expected). check_fixtures.py shows how the tests are meant to be run (stdout is trimmed and compared exactly to expected).
- cline-proof/reference/sdk-check/: verified snippets for the Cline SDK (@cline/sdk 0.0.90, zod 4). 02-clinecore-mock.ts and 03-real-provider-smoke.ts show the real ClineCore pattern HintLab will use: ClineCore.create, cline.start with toolPolicies, capabilities.requestToolApproval, extraTools with a createTool + zod give_hint tool, cline.subscribe events, and cline.send follow-ups. README.md explains what was run.
Do not modify anything under cline-proof/.

What HintLab is: a debugging tutor for programming labs. A student pastes code and picks an assignment. An agent built with the Cline SDK runs the code against the assignment's test cases in a sandbox (a temp directory), diagnoses the failure, and gives tiered hints (level 1 nudge, level 2 where to look, level 3 the concept). It must never write the fix: the editor and apply_patch tools are disabled, run_commands goes through an approval callback that enforces a shell allow-list, hints are delivered only through a custom give_hint tool (createTool + zod, passed via extraTools), and cline.subscribe events are streamed live to the browser over Server-Sent Events.

Stack and API:
- Express + TypeScript server, ESM.
- POST /api/session: body { assignmentId, code } -> creates a session, writes the code into a sandbox temp dir, runs the tests, starts the agent, returns { sessionId, testResults }.
- GET /api/session/:id/stream: SSE stream of agent steps (tool calls, results, hints, done/error).
- POST /api/session/:id/next-hint: asks the agent (via send()) for the next hint level.
- Assignments live in assignments/<id>/ (tests.json plus the buggy starter program, copied from the reference fixtures).
- Static web UI in web/ (plain HTML/CSS/JS served by Express): assignment picker, code box, test results table, live agent step feed, hint cards, "next hint" button.

Known Cline SDK quirks the plan must account for:
1. Node 22+ is required (this machine has Node 24).
2. tsconfig needs "moduleResolution": "Bundler" (with "module": "ESNext").
3. The read_files tool needs absolute paths, so prompts to the agent must give absolute sandbox paths.
4. A follow-up cline.send() only works if the session was started with start({ interactive: true }).
5. run_commands runs on the host, not in a container, so the allow-list in requestToolApproval is the only protection. It must be strict (only the exact build/run commands for the assignment inside the sandbox dir) and the server's own runner must use timeouts.

The build will happen in these steps (one Cline prompt each), so structure the plan around them:
- Step 01: Express + TS server skeleton and the sandboxed code runner (Python and C, build + run with timeouts, output trimmed and compared against assignments/<id>/tests.json). Copy fixtures into assignments/. npm scripts. A check script proving correct pass/fail on the 3 buggy programs. Stub POST /api/session returning test results. No agent, no UI.
- Step 02: the HintLab agent module with the Cline SDK (ClineCore, toolPolicies, allow-list approval, give_hint tool, interactive sessions, next-hint via send()), plus a mock-provider test like the sdk-check mock.
- Step 03: SSE streaming and the real session endpoints.
- Step 04: the web UI.
- Step 05: end-to-end test with the real provider, safety checks (edit tools blocked, non-allow-listed commands blocked, no corrected code in hints), and a README with demo steps.

For each step give: goal, files to create or change, key implementation details, how to verify it, and risks. Also include the expected test results for each fixture (which tests should pass and which should fail with the buggy code, and why). End with a short list of open questions.

Your final answer must be the complete plan as Markdown, ready to be saved as PLAN.md at the repo root.
