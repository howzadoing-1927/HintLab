# Step 06 status: started, not merged

- Prompt: `cline-proof/prompts/06-l3-hint-tightening.md` (goal: stop level 3 hints from spelling out the fix).
- Cline edited `src/agent.ts` (instruction text only, +40/-6) and then hit the ClinePass 5-hour limit at 14:58 IST, before it could verify the change against the model.
- The partial edit was not committed. It was set aside with `git stash` so the demo is recorded on commit `9a65b51` (step 05). The exact diff Cline made is saved in `06-l3-hint-tightening.partial.diff`, and the Cline session log is in `06-l3-hint-tightening.json`.
- Known issue in the shipped code: on some programs the level 3 hint names the methods to use, which comes close to giving away the fix.
