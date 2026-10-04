# Step 1 test report: server and code runner

- Commit tested: `3575cc2` (extracted with `git archive` to a temp dir, so step 2's working-tree changes weren't included)
- Tested by: HintLab Tester, 4 Oct 2026, around 12:50 IST, on Prakhar's Mac (node v24.16.0, Python 3.13.7, Apple clang 16)
- Server: `PORT=3100 npm start`
- Verdict: **PASS**, with 3 non-blocking bugs and the expected lack of a sandbox

## Passed
| Check | Result |
|---|---|
| `npm run test:runner` | All checks pass, including the correct solutions for all 3 assignments |
| `npm run typecheck` | Exit 0 |
| `GET /api/health` | 200 `{"status":"ok"}` |
| `GET /api/assignments` | 200, 3 assignments (average-marks c, is-palindrome python, sum-of-list python) with starter code |
| Starter sum-of-list | 0/4 (got 5, 0, 9, 1), as expected |
| Starter is-palindrome | 2/4 (mixed-case and spaces fail), as expected |
| Starter average-marks (C) | Build ok, 1/3 (got 1.00 and 3.00), as expected |
| Unknown id `nope` | 404 |
| `../etc` | 400 |
| Missing id | 400 |
| `code: 123` | 400 |
| Malformed JSON | 400 |
| 1.5 MB code body | 413 |
| Python `while True: pass` | Each test times out at 5s, so the request takes about 20s; timedOut=true |
| C `for(;;);` | Times out at 5s per test, about 15s total |
| Python crash | exit 1, traceback in stderr |
| C compile error | build_ok=false, gcc errors in build.stderr, 0 tests run |
| 5 MB stdout | Capped at exactly 1,048,576 chars |
| 3 infinite loops in parallel | All finish in about 20s wall time; `/api/health` still answers instantly during the load |

## Bugs (non-blocking)
1. **Orphan child processes survive.** `killProcessTree` only runs on timeout. Repro: POST sum-of-list with code `import subprocess; subprocess.Popen(['sleep','31']); print('x')`. After the response, `sleep 31` is still running. Fix: kill the process group after every run, not only on timeout.
2. **Sandbox temp dirs are never deleted.** The server never passes `cleanup: true`, so every session leaves a `$TMPDIR/hintlab-*` dir behind. One test run left 17 (I deleted those). Fix: clean up after the run, or use the step 2 session TTL.
3. **A segfault shows up blank.** C `int *p=0; *p=1;` gives exitCode=null, timedOut=false and empty stderr, so the signal is lost and the agent or UI has nothing to explain. Fix: record the `signal` from the exit event (for example "SIGSEGV").

## No sandbox yet (as hackbot warned)
Student code runs as Prakhar's user with the server's full environment:
- It can read `/etc/passwd` and list the home dir (58 entries); `~/.ssh` and the repo are visible.
- Network works: an HTTPS GET to example.com returned 200.
- It can write outside the temp dir (`/tmp/...`).
- It inherits the server's whole env (`env: process.env`). Right now the only secret-like name is `SSH_AUTH_SOCK`, but if step 2 puts provider credentials in the env, student code could read them.
- Tracebacks include the absolute temp path (cosmetic).

**Demo and Q&A note:** don't claim "sandboxed execution" for the runner. What's honest is: timeouts, output cap, a temp dir per run, and (step 2) an allow-list on the agent's shell commands.
