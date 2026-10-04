# HintLab

A debugging tutor for programming labs. A student pastes code and picks an
assignment; the server runs the code against the assignment's test cases in a
sandbox, then a Cline‑SDK agent diagnoses the failure and delivers **tiered
hints** (level 1 nudge → level 2 where to look → level 3 concept). It **never**
writes or reveals the fix.

This is **Step 02**: the HintLab tutor agent (built with `@cline/sdk`), wired
into the Express server. There is no web UI yet.

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

### Endpoints

| Method | Path                          | Description                                                      |
| ------ | ----------------------------- | ---------------------------------------------------------------- |
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

The stream maps the SDK's `cline.subscribe` events (filtered by `sessionId`) to
these named events:

| Event            | Meaning                                                       |
| ---------------- | ------------------------------------------------------------- |
| `test_results`   | The runner's test results (inputs / expected / got)           |
| `agent_text`     | Assistant text (`content_start`/`content_end`, type `text`)   |
| `reasoning`      | Model reasoning summaries (if the provider emits them)        |
| `tool_call`      | A tool call started (name + input)                            |
| `tool_result`    | A tool call finished (name + output/error)                    |
| `approval`       | A `run_commands` approval decision (allowed/denied + commands + reason) |
| `hint`           | An accepted hint delivered through `give_hint`                |
| `hint_rejected`  | A hint rejected by the guard (wrong level or code detected)   |
| `status`         | Session status / iteration / usage / notice updates           |
| `error`          | An agent error (often recoverable)                            |
| `done`           | The agent finished a turn                                     |

A `: ping` heartbeat comment is sent every ~15s; buffered events are replayed
to late-joining clients.

## Safety model

- The agent runs with `enableSpawnAgent: false` and `enableAgentTeams: false`.
- All file-editing/network tools are disabled (`editor`, `apply_patch`,
  `fetch_web_content`, `skills`, `ask_question`, `submit_and_exit` →
  `{ enabled: false }`). `read_files` and `search_codebase` are auto-approved.
- `run_commands` is `autoApprove: false` and gated by a strict regex allow-list
  in `capabilities.requestToolApproval` (see `src/allowlist.ts`). Only the
  assignment's own build/run/read commands are allowed; `;`, `&&`, `||`,
  backticks, `$(`, extra pipes and other redirects are rejected. Every approval
  decision is logged as an `approval` event.
- Hints can only be delivered through `give_hint`, and every hint is checked by
  `src/hintGuard.ts` before it is stored/sent. A hint containing a fenced code
  block, long inline code, code-like lines, or a rewritten solution is rejected
  (the model gets an error and rephrases without code).

## Run the checks

```sh
npm run typecheck     # tsc --noEmit
npm run test:runner   # sandboxed runner against the 3 buggy programs
npm run check:agent   # end-to-end, REAL model call (starts a server on :3200)
```

`test:runner` runs the sandboxed runner against all three buggy starter programs
and asserts the exact expected pass/fail of every test, plus a correct solution
for each assignment, an infinite-loop program (must time out), and a C program
with a compile error (must report a build failure).

`check:agent` unit-tests the allow-list (including injection attempts like
`python3 main.py; rm -rf ~` and `cat /etc/passwd`) and the hint guard, then
starts the server on `PORT=3200`, posts a `sum-of-list` session, reads the SSE
stream, and requests hints level 2 and 3. It asserts exactly one accepted hint
per level, that no hint contains code, that no edit/write tool was executed, and
that any denied command was not run. It prints the hints verbatim, the distinct
SSE event types, and the approval decisions, and exits non-zero on failure
(overall timeout 8 minutes). It leaves no server running.

## Typecheck / build

```sh
npm run typecheck   # tsc --noEmit
npm run build       # tsc
```
