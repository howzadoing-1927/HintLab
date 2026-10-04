# Step 4 (960e2d8) README test on fresh Linux — HintLab Tester, 4 Oct 14:10 IST
Box: Debian, gcc 14.2, Python 3.13.5, Node 22.23.3 via nvm (stock Node 20 rejected by engines, as README says). No ~/.cline, no cline CLI.
- npm install: OK
- npm run typecheck: PASS (exit 0)
- npm run test:runner: ALL CHECKS PASSED. This covers 02c on Linux: SIGSEGV reported, no stray sleep, minimal env (no fake secret leak, HOME=temp dir), no temp dirs leaked
- PORT=3100 npm start: health ok, / 200, 3 assignments listed
- is-palindrome starter: 2/4 tests pass
- SSE with no Cline login: test_results, status running, error "Something went wrong. Please try again.", status idle. 0 agent_text, 0 reasoning events
- Not tested on Linux: live hints (needs ClinePass OAuth login)
Gaps:
1. No-login error is generic and the server log prints nothing about the cause, so a judge can't tell it's a missing Cline login. Status goes back to idle, not error
2. README says the sdk-check snippets "remain in git history"; a public repo would show that pre-sprint code in history
