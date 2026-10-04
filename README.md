# HintLab

A debugging tutor for programming labs. A student pastes code and picks an
assignment; the server runs the code against the assignment's test cases in a
sandbox, then a Cline‑SDK agent diagnoses the failure and delivers **tiered
hints** (level 1 nudge → level 2 where to look → level 3 concept). It **never**
writes or reveals the fix.

This is **Step 04**: the full web UI, plus the server-side fixes from the Step 02
review — an explicit SSE event allow-list (no unguarded model output reaches the
browser), friendly errors, a hardened `run_tests` tool that replaces the host
`run_commands` shell, and a stricter allow-list/hint guard.

## Requirements

- Node.js 22+ (verified on Node 24)
- Python 3 (`python3`) on PATH
- `gcc` on PATH (for the C assignment)
- A Cline CLI installation already authenticated with ClinePass (see
  [Agent credentials](#agent-credentials))

## Install

```sh
npm install
```

## Agent credentials (picked up from `~/.cline`)

The agent uses the same ClinePass provider/model as the Cline CLI:

- provider id: `cline-pass`
- model id: `cline-pass/deepseek-v4-pro`

The SDK does **not** need an API key in the repo or in env vars. In local
backend mode (`backendMode: "local"`), `ClineCore.start` resolves credentials
itself from the Cline CLI's config/data directory:

- `~/.cline/data/settings/providers.json` → the `cline-pass` entry, whose
  `settings.auth` holds the OAuth `accessToken`/`refreshToken`. When
  `config.apiKey` is omitted, the SDK's local runtime host resolves the
  provider's OAuth token from this file (refreshing it if expired) and injects
  it for the request.

Treat `~/.cline` as read-only: the server never writes to it, and never logs
any token/secret (it only ever prints provider/model names). You can override
the provider/model via env vars:

```sh
HINTLAB_PROVIDER_ID=cline-pass HINTLAB_MODEL_ID=cline-pass/deepseek-v4-pro npm start
```

## Start the server

```sh
npm run dev      # watch mode
npm start        # run once (tsx src/server.ts)
```

The server listens on `http://localhost:3000` by default. Override with `PORT`:

```sh
PORT=3200 npm start
```

The web UI is served at `http://localhost:3200/` (plain HTML/CSS/vanilla JS, no
build step).

### Using the UI

1. Pick an assignment from the drop-down (it shows the statement and language and
   preloads the buggy starter code into the editor).
2. Edit the code, then press **Run & get hint**.
3. The test-results table appears (name, input, expected, got, PASS/FAIL with
   colour, plus timeout/signal/build errors), and the tutor's activity streams in
   live on the right.
4. Hint cards appear as "Level 1: nudge" → "Level 2: where to look" → "Level 3:
   the concept". Press **Next hint** for the next level (it disables while the
   tutor is busy). Starting a new run resets everything.

### Endpoints

| Method | Path                          | Description                                                      |
| ------ | ----------------------------- | ---------------------------------------------------------------- |
| GET    | `/`                           | Web UI (static `web/`)                                           |
| GET    | `/api/health`                 | Liveness check                                                   |
| GET    | `/api/assignments`            | List assignments (id, language, statement, starter code)         |
| POST   | `/api/session`                | Run a submission + start the agent. Body `{ assignmentId, code? }` |
| GET    | `/api/session/:id/stream`     | Server-Sent Events (replay + live) for the session               |
| POST   | `/api/session/:id/next-hint`  | Ask the agent for the next hint level (2, then 3)                |

`POST /api/session` runs the sandboxed runner, creates a session, starts the
agent in the background asking for a **level‑1** hint, and immediately returns
`{ sessionId, testResults }`. If `code` is omitted, the assignment's starter
program is used. Unknown session ids return `404`; `next-hint` returns `409`
while the agent is still busy, and `{ level: 3, status: "complete" }` once all
three levels have been delivered.

```sh
curl -s -X POST localhost:3200/api/session \
  -H 'content-type: application/json' \
  -d '{"assignmentId":"sum-of-list"}'
```

### SSE event types

The stream only ever forwards a small **allow-list** of event types, each with a
sanitised payload that can never contain the model's own text, reasoning, or raw
SDK/stack-trace messages. Unguarded events (`agent_text`, `reasoning`, and tool
inputs/outputs that carry model free text) are dropped at the server boundary and
are never sent — including to late joiners via the replay buffer.

| Event            | What reaches the client                                       |
| ---------------- | ------------------------------------------------------------- |
| `test_results`   | Test results (name, input, expected, got, pass/fail, signal/timedOut, build error) — never `sandboxDir` |
| `tool_call`      | Only `run_commands` (command), `read_files` (file name), or `run_tests` (test name) |
| `tool_result`    | For `run_commands` a short trimmed output; for `run_tests` the pass/fail summary |
| `approval`       | `allowed`/`denied` + the command (or tool name)               |
| `hint`           | An accepted, guarded hint (`level`, `tag`, `text`)            |
| `hint_status` / `hint_rejected` | Only a reason category (e.g. `wrong level`, `contained code`) — never the rejected text |
| `status`         | Session status string only (`running`/`idle`/`complete`/`error`) |
| `error`          | A short, friendly human line (no stack traces / raw SDK messages) |
| `done`           | The agent finished a turn (reason only)                       |

A `: ping` heartbeat comment is sent every ~15s; buffered events are replayed to
late-joining clients through the same filter.

## Safety model

- The agent runs with `enableSpawnAgent: false` and `enableAgentTeams: false`.
- All file-editing/network tools are disabled (`editor`, `apply_patch`,
  `fetch_web_content`, `skills`, `ask_question`, `submit_and_exit` →
  `{ enabled: false }`). `read_files`, `search_codebase`, `give_hint`, and
  `run_tests` are auto-approved.
- The built-in `run_commands` tool is **disabled** (`enabled: false`). Instead the
  agent gets a custom `run_tests` tool that runs the student's code through the
  hardened server runner (process-group kill, per-test timeouts, minimal env with
  `HOME` set to the sandbox dir, signal reporting) — so student code run by the
  agent can never read server env vars or the credentials in `~/.cline`.
- `requestToolApproval` still denies everything that is not explicitly allowed, so
  any command attempt is blocked and shown as an approval-denied line. The strict
  regex allow-list in `src/allowlist.ts` is retained and unit-tested; it allows
  only `python3 main.py`, the exact `gcc` build command, `./main`, a stdin
  redirect from an `input-*.txt` file, and `cat` of `main.py`/`main.c`/`tests.json`
  or an `input-*.txt` file. Any `$` (variable/command expansion) and any pipe
  (`echo … | program`) are denied. Each test's input is written to its own
  `input-<test-name>.txt` file in the workdir.
- Hints can only be delivered through `give_hint`, and every hint is checked by
  `src/hintGuard.ts` before it is stored/sent. A hint containing a fenced code
  block, inline code, a one-line code expression (indexing/slicing, comparison or
  arithmetic between identifiers, casts, calls, semicolons), or a rewritten
  solution is rejected — while plain prose like "for x in the list" or "if the
  list is empty" still passes.

## Run the checks

```sh
npm run typecheck     # tsc --noEmit
npm run test:runner   # sandboxed runner against the 3 buggy programs
npm run check:agent   # end-to-end, REAL model call (starts a server on :3200)
npm run check:web     # web UI + SSE contract (starts a server on :3200, stops by PID)
```

`test:runner` runs the sandboxed runner against all three buggy starter programs
and asserts the exact expected pass/fail of every test, plus a correct solution
for each assignment, an infinite-loop program (must time out), and a C program
with a compile error (must report a build failure).

`check:agent` unit-tests the allow-list (including `$`-expansion and pipe
injection attempts like `echo $HOME | python3 main.py`) and the hint guard (new
one-line code expressions are rejected; prose like "for x in the list" passes),
then starts the server on `PORT=3200`, posts a `sum-of-list` session, reads the
SSE stream, and requests hints level 2 and 3. It asserts exactly one accepted hint
per level, that no hint contains code, that **no `agent_text`/`reasoning` and no
rejected hint text arrive over SSE**, that `run_commands` was never executed (and
never approved), that `run_tests` was used (or tests were otherwise reported), and
that no edit/write tool ran. It prints the hints verbatim, the distinct SSE event
types, and the approval decisions, and exits non-zero on failure (overall timeout
8 minutes). It leaves no server running.

`check:web` starts the server on `PORT=3200`, fetches `/` (asserting the page
loads with the app title and that `/app.js` and `/style.css` return 200), fetches
`/api/assignments`, starts one real session on `is-palindrome` (or
`average-marks`), reads the SSE stream until the level-1 hint (or a timeout), and
asserts the event types contain no `agent_text`/`reasoning`. It prints the event
types seen and the hint, then stops the server by PID. It leaves no server running.

## Typecheck / build

```sh
npm run typecheck   # tsc --noEmit
npm run build       # tsc
```
