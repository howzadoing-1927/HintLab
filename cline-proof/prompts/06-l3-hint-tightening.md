# Cline prompt 06: l3-hint-tightening
Sent: 2026-10-04 14:55:53 IST
Mode: act (cline --json --thinking medium -c /Users/prakharagarwal/ClineHackathon)
---
Tighten HintLab's level 3 hints in this repo (/Users/prakharagarwal/ClineHackathon). This must be a PROMPT-ONLY change.

The problem: level 3 hints contain no code, but they spell out the exact fix in words. On is-palindrome, a level 3 hint named the two specific Python string methods to call, said to chain them on the value returned by input, and gave the exact order of edits before the equality check. On average-marks (C), the level 3 hint said exactly which variable to cast and to which type. That hands the student the solution.

What to change: only the agent's natural-language instructions, i.e. the system prompt, the per-turn prompts that ask for a hint level (first hint and next-hint), the give_hint tool description text, and any hint-level guidance strings. Find where these live (most likely src/agent.ts). Do NOT change any logic, control flow, types, the hint guard (src/hintGuard.ts), the allow-list, the event filter, the runner, the UI, or the check scripts. If you believe a non-prompt change is truly required, do not make it; explain why in your final report instead.

New level guidance to express in those instructions:
- Level 1 (nudge): a conceptual nudge about what kind of mistake it is, without locating it.
- Level 2 (where to look): point to the area or line and what that part of the code currently does wrong, still without saying how to change it.
- Level 3 (the concept): still the most explicit level. Explain the underlying concept in general terms (for example, how case and spacing affect string comparison, or how integer division behaves in C) and exactly why the student's current code produces the wrong output for the failing tests, referring to their actual inputs and outputs. It must NOT name the specific methods, functions, library calls, casts, types to cast to, operators or keywords the student should use, must NOT describe the exact edit or the sequence of edits, and must NOT say "change X to Y" or "first do A then B". End level 3 by leaving the student to decide the concrete change themselves (for example, asking them which step their program needs before the comparison, or what would make the division keep the fractional part).
- All levels: never write code, never give the corrected line, never describe a rewritten solution in words.
Include one short good and one short bad example of a level 3 hint in the instructions, written in plain prose about a made-up assignment that is NOT one of the three assignments in assignments/ (so the model cannot copy it), to show the difference between explaining the concept and dictating the fix.

Rules:
- Do not modify anything under cline-proof/. Never read, modify, copy or delete anything in ~/.cline.
- Do NOT run any cleanup of temporary folders: never rm -rf or otherwise delete $TMPDIR/hintlab-* (or anything else in the temp directory), even if you see leftovers. Other HintLab servers may be running and using them.
- Use port 3200 only for checks. Never touch, kill, signal or bind to anything on port 3100 or any other port, no broad pkill patterns; stop only processes you started, by PID. Leave no server running.

Verify before finishing: npm run typecheck, npm run test:runner, and npm run check:agent (real model call). Also run one live session yourself on is-palindrome and one on average-marks on port 3200 through levels 1, 2 and 3 (POST /api/session, read the SSE stream, next-hint twice), print the three hints for each verbatim, and judge whether level 3 still names specific methods, casts or edits. If it does, adjust the wording of the instructions only, and re-run. Report the files changed, a summary of the instruction changes, and the hints verbatim.
