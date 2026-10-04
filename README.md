# HintLab

HintLab is a debugging tutor for programming labs. A student picks an assignment (or
pastes their own program), the server runs the code against the assignment's test cases
in a sandboxed temporary directory, and then a Cline-SDK agent diagnoses the failures
and delivers **tiered hints** — level 1 (a conceptual nudge), level 2 (where to look),
level 3 (the underlying concept) — streamed live to the browser. It is an Express +
TypeScript server (ESM, run via `tsx`), a vanilla-JS web UI (no build step), and an agent
built on `@cline/sdk`'s `ClineCore`.

**Safety promise:** the tutor only diagnoses and hints. It **never** writes or reveals
the fix. File-editing and network tools are disabled at the SDK policy level, the host
shell command tool is replaced by a hardened `run_tests` tool and gated by a strict
allow-list, and every hint is checked by a server-side guard before it reaches the
student. Model free text and reasoning are filtered out on the server, so only a small
allow-list of sanitised events ever reaches the browser.

## 1. Prerequisites

| Tool | Version | Why |
|------|---------|-----|
| Node.js | **22 or newer** (the Cline SDK and `package.json` `engines` both require `>=22`) | runtime + SDK |
| npm | bundled with Node | install |
| Python 3 | `python3` on PATH | runs the Python assignments and `test:runner` |
| C compiler | `gcc` (on macOS the `gcc`/`cc` shim from Xcode Command Line Tools — i.e. Apple clang — works) | compiles the C assignment |
| git | any recent | clone |
| Cline CLI (`cline`) | latest (verified on `3.0.68`) | only for real model calls (`check:agent`, `check:web`, and actually using the tutor) |
| `pgrep` | any | used by `npm run test:runner` to assert process-group cleanup (built in on macOS; `procps` on Linux) |

Check what you have:

```sh
node --version      # must be v22+ (verified v24.16.0)
npm --version
python3 --version
gcc --version        # macOS: Apple clang …; Linux: gcc (…)
git --version
cline --version     # optional until you run the agent
```

### macOS

```sh
# Command Line Tools: provides git, python3, and the clang gcc/cc shim
xcode-select --install

# Node.js 22+ (Homebrew)
brew install node@22
brew link node@22 --force   # the force flag may be needed if node is already linked
node --version
```

(Any Node ≥ 22 already installed via nvm or another method is fine too.)

### Linux — Debian / Ubuntu

```sh
sudo apt update
sudo apt install -y git python3 build-essential procps   # gcc, make, pgrep
# Node.js 22+: the distro's `nodejs` may be older than 22, so prefer nvm or NodeSource.
#   nvm:        nvm install 22 && nvm use 22
#   NodeSource: https://github.com/nodesource/distributions
node --version   # must be v22+
```

### Linux — Fedora (dnf)

```sh
sudo dnf install -y git python3 gcc procps-ng   # procps-ng provides pgrep
# Node.js 22+ via nvm or NodeSource, as above.
```

## 2. Cline CLI credentials (ClinePass or API key)

HintLab does **not** ship or read an API key. In local backend mode the SDK resolves
credentials itself from the Cline CLI's config directory (`~/.cline` by default), so the
setup step is to install the CLI and authenticate it. There are two ways to authenticate:

- **ClinePass** (the default, used for the built-in `cline-pass` provider), or
- an **API key** for a provider such as Anthropic or OpenRouter (for judges who do not have
  ClinePass).

1. Install the CLI (installs the `cline` binary):

   ```sh
   npm install -g cline
   cline --version      # verified on 3.0.68
   ```

2. Run `cline auth --help` to see the exact flags. As of CLI `3.0.68` they are:

   ```sh
   cline auth --help
   # Usage: cline auth [options] [provider]
   #   provider                       Provider id (positional shorthand for -p)
   #   -p, --provider <id>            Provider ID
   #   -k, --apikey <key>             API key
   #   -m, --modelid <id>             Model ID
   #   -b, --baseurl <url>            Base URL
   #   --azure-api-version <version>  Azure API version
   #   --config <dir>                 configuration directory
   #   -c, --cwd <path>               Working directory
   #   --data-dir <dir>               Use isolated local state at <dir> instead of ~/.cline
   #   -v, --verbose                  Show verbose output
   #   -h, --help                     display help for command
   ```

   **Path A — ClinePass (OAuth).** Run the login flow (follow the prompts):

   ```sh
   cline auth cline-pass -m cline-pass/deepseek-v4-pro
   # (equivalent: cline auth -p cline-pass -m cline-pass/deepseek-v4-pro)
   ```

   On success the CLI writes the ClinePass credentials to:

   ```
   ~/.cline/data/settings/providers.json   ->   providers["cline-pass"].settings.auth
       { accessToken, refreshToken, expiresAt, accountId, metadata }
   ```

   **Path B — API key.** Authenticate a provider with `-k/--apikey` (a placeholder key is
   shown below — use your real one). Anthropic, for example, with the real model id
   `claude-sonnet-4-5`:

   ```sh
   cline auth -p anthropic -k sk-ant-REPLACE_WITH_YOUR_KEY -m claude-sonnet-4-5
   ```

   or an OpenAI-compatible provider such as OpenRouter:

   ```sh
   cline auth -p openrouter -k sk-or-v1-REPLACE_WITH_YOUR_KEY -m openrouter/auto
   ```

   API-key credentials land in the same file, keyed by provider id, under `settings.apiKey`
   (never printed back to you by HintLab):

   ```
   ~/.cline/data/settings/providers.json   ->   providers["anthropic"].settings.apiKey
   ```

   Confirm with `cline config`.

3. **How the server picks them up:** `src/config.ts` defaults
   `HINTLAB_PROVIDER_ID=cline-pass` and `HINTLAB_MODEL_ID=cline-pass/deepseek-v4-pro`.
   `src/agent.ts` creates `ClineCore.create({ clientName: "hintlab", backendMode: "local" })`
   and passes those ids (and **no** API key) to `cline.start(...)`. In local mode the SDK's
   runtime host reads the provider's credentials from
   `~/.cline/data/settings/providers.json` (OAuth token or API key), refreshes the OAuth
   token if expired, and injects it for the request. Treat `~/.cline` as read-only: the
   server never writes to it and never logs any token or key.

4. **Using a different provider:** the code accepts any provider id and model id that the
   CLI has credentials for — it passes `HINTLAB_PROVIDER_ID` and `HINTLAB_MODEL_ID` straight
   to the SDK. Point HintLab at the provider you authenticated above with the matching
   values, then confirm a real model call works:

   ```sh
   HINTLAB_PROVIDER_ID=anthropic HINTLAB_MODEL_ID=claude-sonnet-4-5 npm start
   # …then, in another shell, with the server running:
   npm run check:agent     # makes a real model call on the chosen provider/model
   ```

   (For the OpenRouter example, use `HINTLAB_PROVIDER_ID=openrouter
   HINTLAB_MODEL_ID=openrouter/auto`.)

   There is **no** `API_KEY` environment variable and no `config.apiKey`: the only
   credential source is `~/.cline` (the providers file written by `cline auth`). The SDK
   also honours the `CLINE_DIR` / `CLINE_DATA_DIR` environment variables to relocate its
   config/data directory (HintLab uses them in `check:auth` to force an unauthenticated
   provider without touching `~/.cline`).

## 3. Environment variables

There is **no `.env` file and no dotenv loading** — `src/config.ts` reads `process.env`
directly. Set them inline (`VAR=value npm start`) or export them. Every variable has a
safe default.

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | `3000` | HTTP port the server listens on |
| `RUN_TIMEOUT_MS` | `5000` | Per-test run timeout (ms) |
| `BUILD_TIMEOUT_MS` | `15000` | Build (`gcc`) timeout (ms) |
| `MAX_OUTPUT_BYTES` | `1048576` (1 MiB) | Max captured stdout/stderr bytes per process |
| `HINTLAB_PROVIDER_ID` | `cline-pass` | Provider id passed to `ClineCore` |
| `HINTLAB_MODEL_ID` | `cline-pass/deepseek-v4-pro` | Model id passed to `ClineCore` |
| `AGENT_TURN_TIMEOUT_MS` | `300000` (5 min) | Max time an agent turn (`start`/`send`) may run |
| `SESSION_TTL_MS` | `1800000` (30 min) | Idle session lifetime before cleanup |
| `SESSION_CLEANUP_INTERVAL_MS` | `60000` (1 min) | How often the cleanup loop runs |
| `HEARTBEAT_MS` | `15000` | SSE keep-alive heartbeat interval |
| `CLINE_DIR` | (SDK: `$HOME/.cline`) | Relocates the Cline CLI config dir (used by `check:auth` to force an empty one) |
| `CLINE_DATA_DIR` | (SDK: `$CLINE_DIR/data`) | Relocates the Cline CLI data dir (providers.json lives under it) |

(Internally the runner also reads `process.env.PATH` to build the minimal environment it
hands to student code — that's the OS `PATH`, not an app setting. `CLINE_DIR` /
`CLINE_DATA_DIR` are honoured by the Cline SDK itself, not by HintLab code.)

## 4. Install and run

```sh
git clone <repo-url> hintlab && cd hintlab
npm install

npm start        # run once (tsx src/server.ts)
npm run dev      # watch mode (tsx watch src/server.ts)
```

Open **http://localhost:3000/** (override the port with `PORT=3300 npm start`). The web
UI is static (plain HTML/CSS/vanilla JS, no build step) and is served from `web/`.

> The check scripts (`check:agent`, `check:web`, `check:auth`) hard-code port **3200**, so
> don't run the server on 3200 while running them.

### Demo walkthrough (sum-of-list)

1. Pick **`sum-of-list`** from the drop-down. The statement ("Read space-separated
   integers on one line and print their sum.") appears and the buggy starter is preloaded
   into the editor (it loops `for i in range(1, len(nums))`, skipping the first number).
2. Click **Run & get hint**. The server runs the code in a fresh temp dir and the
   **Test results** table appears — all 4 tests **FAIL** (`basic` got `5`, `single` got
   `0`, `negatives` got `9`, `first-only-big` got `1`).
3. The **Tutor activity** feed streams live as the agent reads the files (`read_files`)
   and re-runs the tests (`run_tests`).
4. A **Level 1: nudge** hint card appears (the level-1 agent turn starts automatically).
5. Press **Next hint** → **Level 2: where to look**, then **Next hint** again →
   **Level 3: the concept**. The button disables while the tutor is busy, and after
   level 3 the status shows **All hints given**.
6. At no point does the tutor write or show corrected code — you only ever see prose hints.

## 5. npm scripts and checks

| Script | Command | What it does |
|--------|---------|--------------|
| `npm start` | `tsx src/server.ts` | Run the server once |
| `npm run dev` | `tsx watch src/server.ts` | Run in watch mode (restarts on change) |
| `npm run build` | `tsc` | Type-check and emit JS to `dist/` (per `tsconfig.json`) |
| `npm run typecheck` | `tsc --noEmit` | Type-check only, no output |
| `npm run test:runner` | `tsx scripts/check-runner.ts` | Sandboxed runner checks — **no model call** |
| `npm run check:agent` | `tsx scripts/check-agent.ts` | Allow-list + hint-guard unit tests + a **real model** e2e on `sum-of-list` |
| `npm run check:web` | `tsx scripts/check-web.ts` | Static UI + SSE contract + a **real model** session |
| `npm run check:auth` | `tsx scripts/check-auth.ts` | Proves the unauthenticated-tutor error path (no model call, no `~/.cline`) |

- **`npm run typecheck`** — `tsc --noEmit` across `src/` and `scripts/`. No network, no model.
  Pass = exit 0 with no output. A few seconds.
- **`npm run test:runner`** — runs the sandboxed runner against all three buggy starters and
  asserts the exact pass/fail of every test (sum-of-list 0/4, is-palindrome 2/4,
  average-marks 1/3), plus a correct solution for each assignment, an infinite-loop program
  (must time out), a C compile error (must report a build failure), a segfault (must report
  `SIGSEGV`), process-group kill (no stray `sleep` left behind, checked with `pgrep`),
  minimal-env (server env does not leak), and temp-dir cleanup. **No model call.** A few
  seconds. Pass = `ALL CHECKS PASSED`, exit 0.
- **`npm run check:agent`** — first unit-tests the run_commands allow-list (including
  `$`-expansion and pipe injection) and the hint guard; then it starts a server on
  **`PORT=3200`**, posts a `sum-of-list` session, reads the SSE stream, and requests hints
  at levels 2 and 3. It asserts exactly one accepted hint per level, that no hint contains
  code, that **no `agent_text`/`reasoning` and no rejected-hint text reach SSE**, that
  `run_commands` was never executed or approved, that `run_tests` was used (or results
  otherwise reported), and that no edit/write tool ran. **Makes real model calls** (needs the
  ClinePass login above). Overall timeout 8 minutes; prints the hints verbatim, the distinct
  SSE event types, and the approval decisions; exits non-zero on failure. Leaves no server
  running.
- **`npm run check:web`** — starts the server on **`PORT=3200`**, fetches `/` (asserts the
  page title/tagline and that `/app.js` + `/style.css` return 200), fetches
  `/api/assignments`, starts one real session on `is-palindrome` (or `average-marks`), reads
  the SSE stream until the level-1 hint (or a timeout), and asserts the event types contain
  no `agent_text`/`reasoning`. **Makes real model calls.** Stops the server by PID; leaves
  nothing running.
- **`npm run check:auth`** — starts the server on **`PORT=3200`** with `HINTLAB_PROVIDER_ID=anthropic`,
  `HINTLAB_MODEL_ID=claude-sonnet-4-5`, and `CLINE_DIR`/`CLINE_DATA_DIR` pointed at an empty
  temp dir (so the SDK sees no credentials), posts a `sum-of-list` session, reads the SSE
  stream, and asserts an `error` event with `code: "auth"` and the exact message
  `Tutor not connected: run \`cline auth\` (see README)` arrives, that the server log prints
  that line once for the session, and that no hint was produced. **No model call** and it
  never reads or writes `~/.cline`. Stops the server by PID.

> The checks hard-code port **3200** and start/stop their own server; they never touch
> `PORT=3000`, and you should not run the server on 3200 while running them. `typecheck`,
> `test:runner` and `check:auth` are the checks that need no ClinePass login.

## 6. API reference

Base URL `http://localhost:3000` (or your `PORT`).

### `GET /api/health`
- `200` → `{ "status": "ok" }`

### `GET /api/assignments`
- `200` → array of `{ id, language, statement, starterCode }` for each discovered assignment.

### `POST /api/session`
Run a submission and start a background level-1 agent turn.
- Request body: `{ "assignmentId": "sum-of-list", "code": "…" }` — `code` is optional
  (omitted / empty / `null` uses the starter code).
- `200` → `{ "sessionId": "<uuid>", "testResults": { assignmentId, build, tests[], passed, failed, total } }`
  (`testResults` is the sanitised shape below — no `sandboxDir`, trimmed `stderr`).
- Errors: `400` (body not an object, missing/bad `assignmentId`, `code` not a string),
  `404` (unknown `assignmentId`), `500` (internal error).

### `GET /api/session/:id/stream`
Server-Sent Events. `200`/`text/event-stream`; `404` if the session is unknown. Replays the
buffered events, then streams live ones, with `: ping` heartbeats.

### `POST /api/session/:id/next-hint`
Ask for the next hint level (2, then 3).
- `200` → `{ "level": 2, "status": "idle" }` — the hint itself arrives over SSE. After all
  three hints: `{ "level": 3, "status": "complete", "message": "All three hint levels have already been delivered." }`.
- Errors: `404` unknown session, `409` agent still busy.

### Static
`GET /` and the `web/` assets are served with `express.static`.

### SSE event types that reach the client

Only the types below are ever forwarded; everything else (including the model's free text
and reasoning) is dropped by `src/eventFilter.ts`.

| Event | Payload |
|-------|---------|
| `test_results` | `{ assignmentId, build: { ok, timedOut, signal, stderr } \| null, tests: [{ name, input, expected, got, stderr, exitCode, signal, timedOut, passed }], passed, failed, total }` |
| `tool_call` | `run_commands` → `{ toolName, command }`; `read_files` → `{ toolName, file }`; `run_tests` → `{ toolName, testName }` |
| `tool_result` | `run_commands` → `{ toolName, output }`; `run_tests` → `{ toolName, passed, failed, total, build, tests[] }` (`read_files` results are dropped — they would leak the student's code) |
| `approval` | `{ toolName, command, allowed, reason? }` (in HintLab `allowed` is always `false`) |
| `hint` | `{ level, tag, text }` |
| `hint_rejected` | `{ level, reason }` with `reason` ∈ `"wrong level" \| "empty hint" \| "contained code"` (never the rejected text) |
| `hint_status` | whitelisted (reserved); the server currently emits `hint_rejected` instead |
| `status` | `{ status }` — `created`, `running`, `idle`, `complete`, `error` |
| `error` | `{ message }`, plus `{ message, code: "auth" }` when the tutor model is not authenticated (`message` is `Tutor not connected: run \`cline auth\` (see README)`) — a short friendly line, never a stack trace or SDK text |
| `done` | `{ reason }` |

**Filtering:** raw agent events (`agent_text`, `reasoning`, unguarded tool output) are
recorded server-side for debugging but never streamed; `filterEvent` applies the allow-list
and sanitisation to both live events and the replayed history, so late joiners get the same
contract.

### curl examples (server on port 3300)

Create a `sum-of-list` session using the starter code (omit `code`), capture the returned
`sessionId`, then follow the SSE stream:

```sh
BASE=http://localhost:3300
SID=$(curl -s -X POST "$BASE/api/session" \
  -H 'content-type: application/json' \
  -d '{"assignmentId":"sum-of-list"}' | python3 -c 'import sys,json; print(json.load(sys.stdin)["sessionId"])')
echo "session: $SID"
curl -N -s "$BASE/api/session/$SID/stream"
```

(The `-N` keeps `curl` from buffering the SSE lines; press `Ctrl-C` to stop following.)
The stream starts with the sanitised `test_results` event, then the `tool_call`/`tool_result`
events as the tutor reads files and re-runs tests, and finally a `hint` event.

Ask for the next hint (level 2, then 3):

```sh
curl -s -X POST "$BASE/api/session/$SID/next-hint"
# → { "level": 2, "status": "idle" }   (the hint itself arrives over the SSE stream)
```

## 7. Architecture

```
 Browser (web/index.html + app.js — vanilla JS, EventSource)
   │  POST /api/session  { assignmentId, code }
   ▼
 Express + TS server (src/app.ts, src/server.ts)          ESM, run via tsx
   │
   ├─ runAssignment(...,{cleanup:false}) ──► sandbox runner (src/runner.ts)
   │     fresh temp dir os.tmpdir()/hintlab-<uuid>
   │     writes main.py/main.c + tests.json + input-<name>.txt
   │     build (gcc) / run (python3|./main) with per-test timeout,
   │     process-group kill, minimal env (PATH, HOME=run temp dir, LANG)
   │
   ├─ startSession / nextHint ──► ClineCore agent (src/agent.ts)
   │     ClineCore.create({ clientName:"hintlab", backendMode:"local" })   (once, lazy)
   │     cline.start({ interactive:true, prompt, config:{sessionId, providerId, modelId,
   │                   temperature:0, systemPrompt, cwd, workspaceRoot, enableTools,
   │                   enableSpawnAgent:false, enableAgentTeams:false, extraTools},
   │                   toolPolicies, capabilities })
   │     cline.send({ sessionId, prompt })   for the next hint
   │     cline.subscribe(handleCoreEvent)    ->  mapped to SSE events
   │     give_hint (createTool + zod)  +  run_tests (createTool + zod)  via extraTools
   │
   ├─ GET  /api/session/:id/stream  (SSE)  ◄── eventFilter.ts allow-list + sanitisation
   └─ POST /api/session/:id/next-hint
```

### How the SDK is used
- **One `ClineCore`**, created lazily in **local backend mode**
  (`ClineCore.create({ clientName: "hintlab", backendMode: "local" })`) and subscribed once;
  reused across sessions.
- **Start + send:** the first turn is
  `cline.start({ interactive: true, prompt, config: {...}, toolPolicies, capabilities })`;
  follow-up hint levels use `cline.send({ sessionId, prompt })`.
- **Tool policies** (`toolPolicies()` in `src/agent.ts`): `run_commands`, `editor`,
  `apply_patch`, `fetch_web_content`, `skills`, `ask_question`, `submit_and_exit` are
  `{ enabled: false }`; `read_files`, `search_codebase`, `give_hint`, `run_tests` are
  auto-approved.
- **Approval** (`capabilities().requestToolApproval`): returns `{ approved: false }` for
  everything, so any command attempt is blocked and surfaced as an `approval` (denied)
  event — defence-in-depth on top of the disabled `run_commands` policy.
- **`run_commands` allow-list** (`src/allowlist.ts`): first rejects any command containing
  `; && || ` $ | > & newline CR * ?`, then requires an exact match of the whitelist — only
  `python3 main.py`, `python3 main.py < input-*.txt`, `gcc -Wall -O0 main.c -o main`,
  `./main`, `./main < input-*.txt`, and `cat (main.py|main.c|tests.json|input-*.txt)`. Since
  `run_commands` runs **on the host**, this allow-list (plus the disabled policy) is the only
  protection between the model and an arbitrary shell.
- **Custom tools:** `give_hint` and `run_tests` are built with `createTool(...)` + zod
  schemas and passed through `config.extraTools`. `give_hint` is the only hint sink (the
  server-side guard runs inside its `execute`); `run_tests` runs student code through the
  hardened server runner instead of the host shell.
- **Events:** `cline.subscribe(handleCoreEvent)` maps SDK `agent_event`s (tool starts/ends,
  done, error) and `status`/`ended` to the SSE allow-list; model text/reasoning are dropped.
- **Hint guard** (`src/hintGuard.ts`): rejects a hint containing a fenced code block, inline
  code beyond a short identifier, or any line that looks like source code (control flow,
  function calls, assignments, casts, indexing/slicing, comparisons, trailing semicolons).
  A rejected hint becomes a tool error so the model rephrases without code.
- **Sandboxed runner** (`src/runner.ts`): a fresh temp dir per run, per-test/build timeouts,
  `detached:true` + process-group `SIGKILL` to reap child processes, an output cap
  (`MAX_OUTPUT_BYTES`), and a minimal environment — only `PATH`, `HOME` (set to the run's
  temp dir) and `LANG` are set, so the server's `process.env` is not inherited. **It is not
  OS-sandboxed yet:** student code still runs as the host user and could read any file that
  user can read (including `~/.cline`); the temp dir is not a security boundary. Signal
  reporting (`SIGSEGV`, `SIGABRT`, …) and cleanup of the temp dir are included (except the
  agent's workdir, which is removed later at TTL).

### SDK quirks worth knowing
1. **Node 22+** — the SDK and `package.json` `engines` require it.
2. **`moduleResolution: "Bundler"`** (with `module: "ESNext"`) — required by the SDK's type
   exports (`tsconfig.json`).
3. **`read_files` needs absolute paths** — the prompt builder injects
   `path.resolve(sandboxDir, ...)`.
4. **`send()` follow-ups only work after an `interactive: true` `start()`** —
   `src/agent.ts` always starts interactively.
5. **`run_commands` runs on the host** — so the allow-list + disabled policy is the only
   protection; that's why the agent's own test execution goes through the custom `run_tests`
   tool instead.

## 8. Assignments

Each assignment is a directory under `assignments/<id>/` containing a `tests.json` and a
starter source file. `id` is the directory name and must be a "plain slug"
(`^[a-z0-9]+(-[a-z0-9]+)*$` — lowercase letters/digits separated by single hyphens).

`tests.json` shape:

```json
{
  "assignmentId": "sum-of-list",
  "language": "python",
  "statement": "Read space-separated integers on one line and print their sum.",
  "run": "python3 main.py",
  "build": "gcc -Wall -O0 main.c -o main",
  "tests": [
    { "name": "basic", "input": "1 2 3\n", "expected": "6" }
  ]
}
```

- `language`: `"python"` or `"c"`.
- `run`: the command that runs the program; `build` (optional, C only): the compile command.
- Each test: `name` (unique), `input` (fed to stdin verbatim), `expected` (compared to
  trimmed stdout).

The starter file is `main.py` (Python) or `main.c` (C) and is loaded into the editor as the
pre-filled buggy code. To add an assignment, create `assignments/<id>/{tests.json,
main.py|main.c}`; `listAssignments()` discovers it automatically and the runner reads it
fresh per session.

## 9. Troubleshooting

- **`node` too old / `npm install` fails** — the SDK needs Node ≥ 22. `node --version`; install
  Node 22+ (see §1).
- **Missing `gcc` or `python3`** — `test:runner` and the C assignment need them.
  `gcc --version`, `python3 --version`. macOS: `xcode-select --install`. Debian/Ubuntu:
  `sudo apt install -y build-essential python3`. Fedora: `sudo dnf install -y gcc python3`.
- **`EADDRINUSE` / "port already in use"** — another process holds the port. Use
  `PORT=3300 npm start`, or find it: `lsof -i :3000` (macOS) / `ss -ltnp` (Linux), then
  `kill <pid>`. The bundled checks (`check:agent`, `check:web`, `check:auth`) use `PORT=3200`
  and manage their own server, so don't run the server on 3200 while running them.
- **"Tutor timed out" / no hint appears** — a model call was slow or ClinePass expired. Check
  the feed and server log. The per-turn timeout is `AGENT_TURN_TIMEOUT_MS` (default 5 min).
- **ClinePass / API key missing, invalid or expired** — `cline config` shows the current
  provider; re-run `cline auth` (ClinePass OAuth, or an API-key provider — see §2). Without
  valid credentials the agent turn ends in an `error` event and the server prints
  `Tutor not connected: run \`cline auth\` (see README)`. You can prove this path with
  `npm run check:auth`.
- **`cline: command not found`** — the CLI isn't on PATH; run `npm install -g cline` and make
  sure npm's global bin (e.g. `~/.npm-global/bin`) is on `PATH`.
- **A hint is rejected and the tutor rephrases** — normal: the model proposed a code-bearing
  hint and the guard made it rephrase; you'll see `hint_rejected` in the feed.

## 10. Project layout

```
hintlab/
├── README.md
├── PLAN.md                  # build plan (aspirational; the code is the source of truth)
├── package.json             # deps + scripts; engines.node >= 22
├── tsconfig.json            # ESNext + moduleResolution Bundler
├── .gitignore               # node_modules, dist, .env, *.log, *.tmp
├── assignments/
│   ├── sum-of-list/{tests.json, main.py}
│   ├── is-palindrome/{tests.json, main.py}
│   └── average-marks/{tests.json, main.c}
├── src/
│   ├── server.ts            # bootstrap: createApp, cleanup loop, listen
│   ├── app.ts               # express routes + static web/
│   ├── config.ts            # env (PORT, timeouts, provider/model)
│   ├── types.ts             # shared TS types
│   ├── assignments.ts       # discover/load/validate tests.json
│   ├── runner.ts            # sandboxed build+run+compare (Python & C)
│   ├── agent.ts             # ClineCore agent (policies, allow-list, give_hint, run_tests)
│   ├── authFailure.ts       # auth-failure detector + the shared "not connected" message
│   ├── allowlist.ts         # run_commands allow-list
│   ├── hintGuard.ts         # server-side hint guard
│   ├── eventFilter.ts       # SSE allow-list + sanitisation
│   ├── sessions.ts          # in-memory sessions + event bus + TTL cleanup
│   └── sse.ts               # SSE helpers
├── scripts/
│   ├── check-runner.ts      # sandboxed runner checks (no model)
│   ├── check-agent.ts       # allow-list/hint-guard units + real-model e2e
│   ├── check-web.ts         # static UI + SSE contract + real-model session
│   └── check-auth.ts        # unauthenticated-tutor error path (no model, no ~/.cline)
├── web/
│   ├── index.html
│   ├── style.css
│   └── app.js               # vanilla JS UI (EventSource SSE client)
└── cline-proof/
    ├── prompts/             # the build prompts: 00-plan, 00b-write-plan, 01-server-runner,
    │                        #   02-agent, 02c-runner-hardening, 03-web-ui, 03-web-ui.retry,
    │                        #   03r-web-ui-resume, 04-readme, 05-readme-auth-fixes
    ├── sessions/            # full Cline session logs (json/output/timing) per prompt step
    ├── screens/             # UI screenshots + a sample server log
    ├── tests/               # step-1 test notes
    └── reference/fixtures/  # the three sample programs (prepared before the sprint)
```

## 11. How this was built

All application code was written by the **Cline CLI** from the prompts in
`cline-proof/prompts/`, with the full session logs in `cline-proof/sessions/` (and in the
Cline session history). The git commits follow the prompt steps (`00-plan`, `00b-write-plan`,
`01-server-runner`, `02-agent`, `02c-runner-hardening`, `03-web-ui`, `03-web-ui.retry`,
`03r-web-ui-resume`, `04-readme`, `05-readme-auth-fixes`).

## 12. Disclosure

- Example Cline SDK snippets (in the now-removed `cline-proof/reference/sdk-check/`) were
  prepared **before** the sprint and used only as reference material for Cline's SDK API.
  They were never imported by the app and were removed from the repo during the sprint (they
  remain in git history). All app code was written by Cline during the sprint, as shown in
  `cline-proof/` (prompts and session logs) and the Cline session history.
- The three sample buggy programs and their `tests.json` files under
  `cline-proof/reference/fixtures/` were prepared **before** the sprint as test data, and
  were copied unchanged into `assignments/`.
