# HintLab

A debugging tutor for programming labs. A student pastes code and picks an
assignment; the server runs the code against the assignment's test cases in a
sandbox and (in later steps) delivers tiered hints.

This is **Step 01**: the Express + TypeScript server skeleton and the sandboxed
code runner. There is no Cline SDK agent or web UI yet.

## Requirements

- Node.js 22+ (verified on Node 24)
- Python 3 (`python3`) on PATH
- `gcc` on PATH (for the C assignment)

## Install

```sh
npm install
```

## Start the server

```sh
npm run dev      # watch mode
npm start        # run once (tsx src/server.ts)
```

The server listens on `http://localhost:3000` by default. Override with `PORT`:

```sh
PORT=4000 npm start
```

### Endpoints

| Method | Path              | Description                                            |
| ------ | ----------------- | ------------------------------------------------------ |
| GET    | `/api/health`     | Liveness check                                         |
| GET    | `/api/assignments`| List assignments (id, language, statement, starter code) |
| POST   | `/api/session`    | Run a submission. Body: `{ assignmentId, code? }`       |

`POST /api/session` returns `{ sessionId, testResults }`. If `code` is omitted,
the assignment's starter program is used.

```sh
curl -s -X POST localhost:3000/api/session \
  -H 'content-type: application/json' \
  -d '{"assignmentId":"sum-of-list","code":"print(sum(map(int, input().split())))"}'
```

## Run the runner check

```sh
npm run test:runner
```

This runs the sandboxed runner against all three buggy starter programs and
asserts the exact expected pass/fail of every test, plus a correct solution for
each assignment (to prove the runner can pass), an infinite-loop program (must
time out), and a C program with a compile error (must report a build failure).
It prints a table and exits non-zero on any mismatch.

## Typecheck / build

```sh
npm run typecheck   # tsc --noEmit
npm run build       # tsc
```
