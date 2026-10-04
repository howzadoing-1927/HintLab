# Steps 02c + 3 (a944e7d), HintLab Tester verdicts, 4 Oct 14:20 IST
Raw output run by hackbot on the Mac (my Mac connection is down); verdicts mine. Also cross-checked on Linux at 960e2d8 (test:runner ALL PASS).
1. Orphan processes: PASS (no `sleep 300` left)
2. Temp dirs: PASS for runner (34 -> 34, incl. timeout). Known minor: sessions keep dirs (cleanup:false) until 30-min TTL; left behind if server is killed
3. Segfault: PASS (signal SIGSEGV + clear stderr; L1 hint no code)
4. Env: PASS (PATH, HOME=temp dir, LANG, __CF_USER_TEXT_ENCODING only). Minor: PATH includes /Users/prakharagarwal/... npm dirs. Not an OS sandbox: absolute paths in home are still readable
5. Palindrome flow: PASS (2/4; 0 agent_text, 0 reasoning; 3 hints, no code; L1-L3 22.7s; next-hint 200 then complete)
6. Injection: PASS (hints only about off-by-one; no approval/hint_rejected/error; UI shows 0/4, L1 card ~10s, injected comment visible at top of editor)
7. Bad credentials: PARTIAL. Friendly line shown, no stack trace. But cause not shown or logged (raw SDK said Unauthorized). Fix in step 05, retest then
8. Double next-hint: PASS (409 + 200, exactly one L2, button disables)
Verdict: PASS except 7, pending step 05.
