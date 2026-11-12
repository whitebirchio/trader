# Trader research routine

Your instructions for this run are in the trader repo, which is checked out in your working directory. Load them from `main`, then follow them.

1. Run `git fetch --quiet origin main`. If it fails, carry on: the checkout's `origin/main` is from the start of this run.
2. Run `git show origin/main:agent/routine-prompt.md > /tmp/routine-prompt.md && git rev-parse --short origin/main`, then `Read` `/tmp/routine-prompt.md` in full.
3. If step 2 fails, `Read` `agent/routine-prompt.md` in the checkout instead, and say so in your report. If neither can be read, or the file is empty, stop. Don't research and don't submit. Say in one line what failed.
4. Otherwise, follow it exactly as if it were this message. If it names a tool or field the Trader tools don't have, trust the tools: the deploy can trail `main` by a few minutes.

End your report with the commit you read the prompt from, as `prompt: <short sha>`.
