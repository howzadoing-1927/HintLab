I've read all the reference material, the fixtures, the SDK snippets, and confirmed the environment (Node v24.16.0, Python 3.13.7, clang/gcc 16.0.0, empty repo root except `cline-proof/`). Here is the complete build plan, ready to be saved as `PLAN.md`.

---

# HintLab — Build Plan

> A debugging tutor for programming labs. A student pastes code and picks an assignment; a Cline‑SDK agent runs it against the assignment's test cases in a temp sandbox, diagnoses the failure, and delivers **tiered hints** (level 1 nudge → level 2 where to look → level 3 concept). It must **never** write or reveal the fix.

## 1. Architecture overview

```
Browser (web/) ──POST /api/session──────────────► Express/TS server (src/)
   │            { assignmentId, code }              │
   │◄──────────── { sessionId, testResults } ───────┤
   │                                                ├─► Sandbox runner (src/runner.ts)
   │◄──GET /api/session/:id/stream (SSE)────────────┤     temp dir, build+run, trim, compare
   │      tool steps · results · hints · done/error │
   │                                                ├─► ClineCore agent (src/agent.ts)
   │◄──POST /api/session/:id/next-hint──────────────┤     toolPolicies + allow-list + give_hint
   │      (agent via cline.send)                    │
                                                    └─► assignments/<id>/tests.json (+starter)
```

- **Server**: Express + TypeScript, ESM (`"type": "module"`), run via Node's built-in type stripping (`node --experimental-strip-types`) so there is no bundler/build step in the runtime path (matches how `sdk-check` was run).
- **Agent**: `@cline/sdk` 0.0.90 with `ClineCore`, `zod` 4.
- **Sandbox**: a fresh temp dir per session (e.g. `os.tmpdir()/hintlab-<id>`). The server's own runner executes the assignment's build/run commands there with timeouts.
- **Safety**: `editor`/`apply_patch` disabled; `run_commands` gated by a strict shell allow-list in `requestToolApproval`; hints only through a custom `give_hint` tool; `run_commands` runs on the host, so the allow-list + timeouts are the only protection.

## 2. Repository layout (all new, outside `cline-proof/`)

```
/Users/prakharagarwal/ClineHackathon
├── PLAN.md
├── package.json
├── tsconfig.json
├── .gitignore                # node_modules, dist, .env, *.tmp
├── .env.example
├── assignments/              # copied from cline-proof/reference/fixtures (read-only source)
│   ├── sum-of-list/{tests.json, main.py}
│   ├── is-palindrome/{tests.json, main.py}
│   └── average-marks/{tests.json, main.c}
├── src/
│   ├── server.ts             # bootstrap: env, create app, listen
│   ├── app.ts                # express app + routes + static web/
│   ├── config.ts             # env loading (provider/model/api key/port/timeouts)
│   ├── types.ts              # shared TS types (Assignment, Test, TestResult, Hint, Session…)
│   ├── assignments.ts        # list assignments, load/validate tests.json
│   ├── sandbox.ts            # temp dir create/copy/write student code
│   ├── runner.ts             # build + run + trim + compare (Python & C)
│   ├── agent.ts              # HintLab agent (ClineCore, toolPolicies, allow-list, give_hint)
│   ├── sessions.ts           # in-memory session store + event bus
│   └── sse.ts                # SSE helper (write event, heartbeat, replay)
├── scripts/
│   ├── copy-assignments.mjs  # copy fixtures → assignments/
│   ├── check-runner.ts       # prove pass/fail on the 3 buggy programs (exit ≠0 on mismatch)
│   ├── agent-mock.test.ts    # mock-provider agent test (no API key)
│   └── e2e-safety.ts         # real-provider e2e + safety assertions
└── web/
    ├── index.html
    ├── style.css
    └── app.js
```

## 3. Environment & SDK quirk checklist

| # | Quirk | Where handled |
|---|-------|---------------|
| 1 | Node 22+ required (machine has v24.16.0) | `package.json` `engines` ≥22; document; no action needed beyond confirming |
| 2 | `moduleResolution: "Bundler"` + `module: "ESNext"` | `tsconfig.json` (copy the sdk-check tsconfig: `target ES2022`, `strict`, `skipLibCheck`, `noEmit`, `allowImportingTsExtensions`, `types:["node"]`) |
| 3 | `read_files` needs absolute paths | prompt builder injects `path.resolve(sandboxDir)` for code + tests |
| 4 | `send()` follow-up only works with `interactive: true` | `agent.ts` always calls `start({ interactive: true, … })` |
| 5 | `run_commands` runs on the host | allow-list in `requestToolApproval`; server runner uses timeouts; allow-list regexes forbid shell metacharacters & `/` outside the fixed prefix |

## 4. Fixture analysis — expected test results

**sum-of-list** (`main.py`) — bug: `for i in range(1, len(nums))` starts at index 1, skipping `nums[0]`.
| test | input | expected | buggy got | result |
|---|---|---|---|---|
| basic | `1 2 3` | `6` | `5` | ❌ FAIL |
| single | `7` | `7` | `0` | ❌ FAIL |
| negatives | `-4 10 -1` | `5` | `9` | ❌ FAIL |
| first-only-big | `100 1` | `101` | `1` | ❌ FAIL |

→ **0/4 pass.** Root cause: off-by-one (loop should start at `range(0, len(nums))`).

**is-palindrome** (`main.py`) — bug: compares raw string, never ignores case/spaces.
| test | input | expected | buggy got | result |
|---|---|---|---|---|
| simple | `racecar` | `YES` | `YES` | ✅ PASS |
| not | `hello` | `NO` | `NO` | ✅ PASS |
| mixed-case | `Madam` | `YES` | `NO` | ❌ FAIL |
| spaces | `never odd or even` | `YES` | `NO` | ❌ FAIL |

→ **2/4 pass.** Root cause: missing normalization (lowercase + strip spaces before reversing).

**average-marks** (`main.c`) — bug: `float avg = sum / n;` is integer division.
| test | input | expected | buggy got | result |
|---|---|---|---|---|
| even | `2\n10 20` | `15.00` | `15.00` | ✅ PASS |
| fraction | `3\n1 2 2` | `1.67` | `1.00` | ❌ FAIL |
| half | `2\n3 4` | `3.50` | `3.00` | ❌ FAIL |

→ **1/3 pass.** Root cause: integer truncation (needs `(float)sum / n`).

> Note the "correct" hint for each: sum-of-list → off-by-one; is-palindrome → normalization; average-marks → float division. These tags feed `give_hint.tag`.

---

## 5. Step-by-step build plan

### Step 01 — Server skeleton + sandboxed code runner

**Goal**: Stand up Express + TS (ESM), copy fixtures into `assignments/`, implement the sandboxed runner (Python + C, build + run, timeouts, trim + compare against `tests.json`), and stub `POST /api/session`. No agent, no UI.

**Files to create/change**
- `package.json` — deps: `express` (^5), `@cline/sdk` (^0.0.90), `zod` (^4.6.5); dev: `typescript` (^5.9), `@types/node`, `@types/express`. `"type":"module"`, `"engines":{"node":">=22"}`. Scripts:
  - `copy-assignments`: `node scripts/copy-assignments.mjs`
  - `check-runner`: `node --experimental-strip-types --no-warnings scripts/check-runner.ts`
  - `typecheck`: `tsc --noEmit`
  - `dev`: `node --experimental-strip-types --no-warnings --env-file=.env src/server.ts`
- `tsconfig.json` — as in quirk #2.
- `.gitignore`, `.env.example` (PORT, and provider fields for later).
- `scripts/copy-assignments.mjs` — `cp` each dir under `cline-proof/reference/fixtures/` into `assignments/` (idempotent, skip the `check_fixtures.py` helper and any compiled `main` binary).
- `src/config.ts` — `PORT` (default 3000), timeouts (`RUN_TIMEOUT_MS=5000`, `BUILD_TIMEOUT_MS=10000`).
- `src/types.ts` — `Assignment { id, language, statement, build?, run, tests[] }`, `TestCase { name, input, expected }`, `TestResult { name, passed, expected, actual?, error?, timedOut? }`, `RunReport { buildOk, buildError?, results[] }`.
- `src/assignments.ts` — `listAssignments()` (scan `assignments/*/tests.json`), `loadAssignment(id)` (validate id ∈ known set, reject `..`/slashes), zod-validate shape.
- `src/sandbox.ts` — `createSandbox(assignmentId, code)`: `fs.mkdtempSync(path.join(os.tmpdir(), "hintlab-"))`, copy template, overwrite the code file (`main.py` for python, `main.c` for c).
- `src/runner.ts` — `runAssignment(assignment, sandboxDir)`:
  - if `build` present: run it in `sandboxDir` (timeout, capture stderr); non-zero ⇒ build failure.
  - for each test: run `run` command with test `input` on stdin; `got = stdout.strip()`; `passed = got === expected`; timeout ⇒ `timedOut`.
  - **Key detail**: use `child_process.spawn(cmd, { shell:true, cwd: sandboxDir, env: minimal, timeout })`, write `input` to `child.stdin`, capture `stdout`/`stderr`; on timeout kill the process **group** (`detached:true` + `process.kill(-pid)`) to avoid orphaned children (e.g. a hung `while True`). Trim with `.strip()` exactly as `check_fixtures.py` does; compare exactly.
- `src/app.ts` + `src/server.ts` — `GET /api/assignments` (list + statement + starter source for prefilling), `POST /api/session` stub: validate `{ assignmentId, code }`, create sandbox, run tests, return `{ sessionId, testResults }` (sessionId placeholder; agent wired in Step 02/03).
- `scripts/check-runner.ts` — run the runner against all 3 assignments using the buggy starter code, print the table, and **exit non-zero if the pass/fail set deviates** from §4.

**How to verify**
- `npm install` clean; `npm run copy-assignments` populates `assignments/`.
- `npm run check-runner` prints exactly the §4 results and exits 0.
- `npm run typecheck` passes.
- `npm run dev` then `curl -s -X POST localhost:3000/api/session -H 'content-type: application/json' -d '{"assignmentId":"sum-of-list","code":"nums=list(map(int,input().split()));print(sum(nums))"}'` → all 4 tests **pass** (proves the runner isn't just always-failing); re-run with the buggy code → all 4 fail.

**Risks**
- Shell command handling (use `shell:true` for the trusted `tests.json` commands, but always with `cwd` inside the sandbox).
- Timeout/orphan cleanup must actually kill the process group.
- Path traversal via `assignmentId` — validate against the known directory list, never interpolate raw input into a path.
- Language dispatch (python vs c) must pick the right filename (`main.py` vs `main.c`).
- `.strip()` semantics must match `check_fixtures.py` exactly (no `lower()`, no whitespace collapse).

---

### Step 02 — HintLab agent module (Cline SDK)

**Goal**: Implement `src/agent.ts` using `ClineCore`, with disabled edit tools, an allow-list approval callback, the `give_hint` tool, interactive sessions, and `next-hint` via `send()`. Add a mock-provider test (no API key) mirroring `sdk-check`.

**Files to create/change**
- `src/agent.ts` — the core of the product:
  - Singleton `cline = await ClineCore.create({ clientName: "hintlab", backendMode: "local" })` created once at startup.
  - `giveHint = createTool({ name: "give_hint", description: "Show exactly one hint… level 1 nudge, 2 location, 3 concept. Never include corrected code.", inputSchema: z.object({ level: z.number().int().min(1).max(3), tag: z.string(), text: z.string() }), execute })` — `execute` records the hint into the session and returns `{ shown: true }`.
  - **Allow-list** built per assignment from its exact `build`/`run` strings, e.g. for python: `/^python3 main\.py$/`, `/^python3 main\.py < [\w.-]+$/`, `/^(echo|printf) [\w .-]+ \| python3 main\.py$/`; for C: `/^gcc -Wall -O0 main\.c -o main$/`, `/^\.\/main$/`, `/^\.\/main < [\w.-]+$/`. Also allow `cat <sandbox-relative file>`. **Hardening vs the reference**: replace the reference's `.*` with `[\w .-]+` so `;`, `&`, `|`, backticks, `$()`, `>` and `/` are impossible in the variable part, and anchor with `^…$`. (The reference `echo .* | …` regex would match `echo x; rm -rf / | python3 main.py` — do not copy that gap.)
  - `requestToolApproval(req)`: read `req.input.commands`, map each to string, require **all** to match an allow-list entry; return `{ approved: true }` or `{ approved: false, reason: "Command not on the HintLab allow-list" }`. Reject empty command lists.
  - `startSession(session, assignment, testResults)`:
    - `prompt` includes **absolute** `sandboxDir` paths for the code and `tests.json`, the statement, and the already-computed `testResults`, plus: "Diagnose the root cause, then call `give_hint` once with level 1. Use absolute paths for `read_files`. Never write or show corrected code."
    - `config`: `{ sessionId, providerId, modelId, apiKey, baseUrl, systemPrompt, cwd: sandboxDir, workspaceRoot: sandboxDir, enableTools: true, enableSpawnAgent: false, enableAgentTeams: false, extraTools: [giveHint] }`.
    - `toolPolicies`: `read_files`/`search_codebase` autoApprove true; `run_commands` autoApprove **false**; `editor`/`apply_patch` enabled false; `fetch_web_content` enabled false; `give_hint` autoApprove true.
    - `start({ interactive: true, prompt, config, toolPolicies, capabilities: { requestToolApproval } })`.
  - `cline.subscribe(...)` mapping (`agent_event` → `payload.event` with `content_start`/`content_end` for `contentType` "tool"/"text", plus lifecycle/usage/error) into per-session events; in Step 02 this just logs/collects.
  - `nextHint(session)`: track `lastHintLevel` from `give_hint`; call `cline.send({ sessionId, prompt: "The student is still stuck. Give the next hint level (currently level N)." })`.
  - `systemPrompt`: "You are HintLab, a programming tutor. You may read files and run allow-listed commands. You must never write or show corrected code. Deliver help only through the `give_hint` tool."
- `scripts/agent-mock.test.ts` — port `mock-openai.ts` + `02-clinecore-mock.ts` into a test that asserts: (a) `give_hint` executes and records a hint; (b) an allow-listed command is approved; (c) a non-allow-listed command (`rm -rf /tmp/x`, `cat /etc/passwd`) is **blocked** (`approved:false`) and not executed; (d) `editor`/`apply_patch` are absent from the model's tool list; (e) `send()` follow-up works (interactive session).

**How to verify**
- `npm run typecheck` passes.
- `node --experimental-strip-types scripts/agent-mock.test.ts` runs with no API key and all assertions pass.
- (Optional, with a real key) a `smoke:real` equivalent of `03-real-provider-smoke.ts` produces one hint for `sum-of-list`.

**Risks**
- Exact built-in tool names/IDs to disable in `@cline/sdk` 0.0.90 — need to enumerate **all** write-capable tools (`editor`, `apply_patch`, and possibly `write_to_file`) and all network tools; missing one = a way for the model to mutate files.
- Allow-list too strict ⇒ agent can't re-run tests; too loose ⇒ sandbox escape. Pre-write per-test input files (`tests/input-<name>.txt`) in the sandbox so the agent can use `< tests/input-basic.txt` instead of inventing pipes.
- `give_hint` must auto-approve so it's never blocked, but its `execute` is the only hint sink.
- The model might bypass `give_hint` and print an answer/code as plain text — system prompt must forbid this, and the UI should surface only `give_hint` payloads as "hints".
- `send()` silently no-ops without `interactive: true` — asserted in the mock test.

---

### Step 03 — SSE streaming + real session endpoints

**Goal**: Wire the agent into HTTP: `POST /api/session` creates the session, runs tests, and **starts the agent in the background**; `GET /api/session/:id/stream` streams agent steps/hints; `POST /api/session/:id/next-hint` calls `send()`.

**Files to create/change**
- `src/sessions.ts` — in-memory `Map<sessionId, Session>` where `Session = { id, assignmentId, code, sandboxDir, testResults, status, hints[], steps[], subscribers:Set<SSE client>, lastHintLevel, agentSessionId }`. Include a TTL/cleanup.
- `src/sse.ts` — `openSse(res)` (headers `text/event-stream`, `cache-control: no-cache`, `connection: keep-alive`), `sendEvent(res, name, data)` → `event: <name>\ndata: <json>\n\n`, a heartbeat `: ping` every ~15s, and buffered-event **replay** for late joiners.
- `src/app.ts` (routes):
  - `POST /api/session`: zod-validate body; create sandbox; run tests (Step 01 runner); store session; **fire-and-forget** `agent.startSession(...)` (subscribe first so no events are missed); return `{ sessionId, testResults }` immediately.
  - `GET /api/session/:id/stream`: register the SSE client, replay buffered steps/hints, stream live events (`tool_start`, `tool_result`, `hint`, `text`, `status`, `done`, `error`).
  - `POST /api/session/:id/next-hint`: if the agent is still running return `409`; else call `agent.nextHint()` and let the resulting hint arrive over SSE.
  - Map agent events: `content_start`/`content_end` (contentType `tool` → tool name + input/output/error; contentType `text` → text), lifecycle → `done`/`error`. `give_hint` execute → `hint` event.
- `src/server.ts` — create the `ClineCore` singleton before listening; start listening.

**How to verify**
- `npm run dev`; `POST /api/session` returns `testResults` instantly; `curl -N localhost:3000/api/session/<id>/stream` shows tool calls then a level-1 hint; `POST /api/session/<id>/next-hint` yields a level-2 hint on the same stream.
- Reconnect a second stream after completion → sees replayed history then `done`.
- Kill-path: an invalid provider config produces an `error` event on the stream, not a hung request.

**Risks**
- SSE lifecycle/leaks (client disconnect cleanup), and memory growth (session TTL).
- Ordering: subscribe to `cline` **before** `start()` resolves/starts producing events.
- Concurrency: only one in-flight `send()` per session; queue or 409 extra `next-hint` requests.
- Mapping the SDK's event payload shape (`agent_event.payload.event` with `content_start`/`content_end`) exactly — see `02`/`03` for the field names (`toolName`, `input`, `output`, `error`, `contentType`).

---

### Step 04 — Web UI

**Goal**: Plain HTML/CSS/JS UI (no build step) served by Express: assignment picker, code box, test-results table, live agent step feed, hint cards, "next hint" button.

**Files to create/change**
- `web/index.html`, `web/style.css`, `web/app.js`.
- `src/app.ts` — add `app.use(express.static("web"))` and ensure `GET /api/assignments` returns `{ id, language, statement, starter }` (starter = buggy `main.py`/`main.c`) so the picker can prefill.

**Key implementation details**
- Picker: fetch `/api/assignments`, populate `<select>`, show statement, prefill the textarea with the starter.
- "Run & get hints": `POST /api/session { assignmentId, code }` → render a test-results table (name, expected, actual, ✅/❌, optional error), then open `EventSource("/api/session/<id>/stream")`.
- Live feed: append a step line per `tool_start`/`tool_result`/`text`; render `hint` events as **hint cards** (level badge, tag, text). Show a spinner while `status !== done`.
- "Next hint" button: `POST next-hint`, disabled while the agent is busy; the new hint arrives over the existing SSE.
- State machine: sessionId comes back from `POST` **before** the stream opens; handle `done`/`error`; friendly message on validation errors (empty code, unknown assignment).

**How to verify**
- Open the UI, pick `sum-of-list`, submit the buggy code → see 4 failed tests, live tool steps, a level-1 hint card; click "next hint" → level-2 card.
- Submit empty code / bogus id → friendly error, no crash.
- Confirm no corrected code appears anywhere in the UI.

**Risks**
- `EventSource` ordering (must have `sessionId` first).
- Same-origin assumed (no CORS); confirm port matches.
- Keep raw agent reasoning/text minimal in the UI (noise + risk of leaking code); prefer tool steps + hint cards.

---

### Step 05 — End-to-end test with real provider + safety checks + README

**Goal**: Prove the full loop against a real model, verify the three safety guarantees, and document the demo.

**Files to create/change**
- `scripts/e2e-safety.ts` — with `PROVIDER_ID`/`MODEL_ID`/`API_KEY`/`BASE_URL`, run a session against each of the 3 assignments; assert `testResults` match §4 and at least one level-1 hint is produced; exercise `next-hint` to level 2.
- `scripts/` safety assertions (some in mock test, some in e2e):
  1. **Edit tools blocked** — assert `editor`/`apply_patch` (and `write_to_file` if present) are never offered/executed (watch tool events; fail the run if any edit tool fires).
  2. **Non-allow-listed commands blocked** — attempt `rm -rf …`, `cat /etc/passwd`, `ls /` → assert `approved:false` and no execution (mock test covers deterministically).
  3. **No corrected code in hints** — scan each `give_hint.text` for code markers (`for `, `def `, `printf`, `range(`, `(float)`, `.lower()`, braces/`;`) and assert it doesn't contain a fix; plus manual review.
- `README.md` — overview, architecture diagram, stack, setup (`npm install`, `cp .env.example .env`, `npm run copy-assignments`), run instructions, endpoints table, demo walkthrough (pick assignment → paste buggy code → watch tests fail → hints 1/2/3 → never shows the fix), safety model explanation, and how to run tests (`check-runner`, `agent-mock.test`, `e2e-safety`).

**How to verify**
- `npm run e2e` (with a real key) passes: correct test results, ≥1 hint, next-hint works, no edit tool fired, no blocked-command execution, no code in hints.
- README steps are copy-paste runnable on a fresh clone.

**Risks**
- Real-model nondeterminism (may not call `give_hint`, may choose wrong level, may try to write code) → use temperature 0, a strong system prompt, and tolerant assertions ("≥1 hint", not exact text); add retries.
- Safety check #3 is heuristic — combine automated markers with a mandatory human review of any hint text before demo.
- Cost/time of the real-provider run.

---

## 6. Open questions

1. **Provider + model** for the real run (Anthropic vs OpenRouter vs Groq) and the exact `MODEL_ID`; should `npm run dev` default to the mock provider when no key is set?
2. **Built-in tool inventory**: the exact write-capable and network tool names exposed by `@cline/sdk` 0.0.90 (`editor`, `apply_patch`, `write_to_file`?, `fetch_web_content`, spawn/team tools) — confirm the full disable list in Step 02.
3. **Hint progression policy**: strict 1→2→3 increment, or may the agent choose? Behavior after level 3 (terminal message)?
4. **Persistence**: is the in-memory session store + TTL acceptable for the hackathon demo, or is disk/redis needed?
5. **Server runner vs allow-list**: the server's own runner runs `tests.json` commands directly (trusted, no allow-list) — the allow-list only gates the *agent's* `run_commands`. Confirm this split is intended.
6. **ClineCore lifecycle**: one shared singleton (preferred) vs per-session instance, and how `send()` references the correct session.
7. **UI verbosity**: show agent reasoning/raw text, or only tool steps + hint cards (recommended: the latter, to avoid leaking the fix)?
8. **Timeout budget**: acceptable max per test run (5s?) and per agent run (e.g. 120s) before the session is marked errored.

---

This plan is complete and ready to save as `PLAN.md`. Once you approve it (switch me to Act mode), I'll begin with Step 01.