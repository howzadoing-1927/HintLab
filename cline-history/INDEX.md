# HintLab: Cline chat history (complete, unedited)

Exported 2026-10-04 at about 17:00 IST from `~/.cline/data/sessions` on the build Mac (Cline CLI, provider `cline-pass`, model `cline-pass/deepseek-v4-pro`).

- `build-sessions/raw/`: every Cline CLI session (`"source": "cli"`), 11 in total, copied byte for byte. This is all the work of Cline writing HintLab.
- `build-sessions/html/`: the same sessions rendered by Cline's own `cline history export <id>`, which is easier to read.
- `tutor-runs/raw/`: 36 sessions with `"source": "core"`. These are HintLab itself running, not Cline building it. The app's tutor agent uses `@cline/sdk`, so its runs land in the same folder. They come from tests, checks and filming. They're kept unedited and labelled here so nothing is hidden.
- `cline-history-list.json`: the output of `cline history --json`, Cline's own list of all 47 sessions.
- `SHA256SUMS.txt`: SHA-256 hashes of all 94 session files. Run `shasum -a 256 -c SHA256SUMS.txt` (or `sha256sum -c` on Linux) inside this folder to check them. They match the originals in `~/.cline/data/sessions` byte for byte.

Nothing was deleted, trimmed or reformatted. The prompts were written by the hackbot assistant (directed by team HintLab) and sent to the Cline CLI. Cline wrote all of the app code.

## Build sessions to steps to commits (times in IST)

| # | Session | Started | Status | Step | Commit |
|---|---------|---------|--------|------|--------|
| 01 | `1791096148779_py2mn` | 12:12 | failed, no messages recorded | First attempt at the plan. It produced nothing. The prompt is kept in the session metadata. Cline's HTML export skips it because it has no messages. | none |
| 02 | `1791096626437_mirqt` | 12:20 | completed | 00 plan (plan mode) | `1e62711` |
| 03 | `1791096827260_0gnn3` | 12:23 | completed | 00b write PLAN.md (act mode) | `1e62711` |
| 04 | `1791096925227_9e1ak` | 12:25 | completed | 01 server and test runner | `3575cc2` |
| 05 | `1791097504436_aht7y` | 12:35 | completed | 02 agent (`@cline/sdk`, give_hint, hint guard) | `b30d91e` |
| 06 | `1791099070830_2z9el` | 13:01 | completed | 02c runner hardening (after tester report) | `5454cd7` |
| 07 | `1791100011489_tme58` | 13:16 | failed | 03 web UI. A provider error stopped it ("Upstream stream ended before terminal chunk"). A resume attempt (03r) was rejected by the CLI before a session started. | none |
| 08 | `1791100413686_7gzul` | 13:23 | completed | 03 web UI retry, same prompt | `a944e7d` |
| 09 | `1791102093260_cz02g` | 13:51 | completed | 04 README | `960e2d8` |
| 10 | `1791103147020_h540i` | 14:09 | completed | 05 auth error handling and README fixes | `9a65b51` |
| 11 | `1791105954902_gy8rr` | 14:55 | failed | 06 level 3 hint tightening. It stopped when the ClinePass 5-hour limit hit. It was not merged, and the partial diff is in `cline-proof/sessions/`. | none |

No Cline build sessions ran after 14:55. The account was later switched to a teammate's ClinePass (see `cline-proof/sessions/ACCOUNT-SWITCH.md`), but only to run HintLab for checks and the demo video. Some demo runs were filmed on a second computer. Those were also tutor runs and are not in this folder.

`cline-proof/` in this repo holds our own copies of each prompt, the CLI's JSON output, the timing and verify logs, and the tester reports. It's extra context. This folder is the Cline record itself.
