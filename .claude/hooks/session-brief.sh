#!/bin/bash
# SessionStart hook: inject the team board's claims + latest notes and recent test flags as context.
cd "$(dirname "$0")/../.." || exit 0
{
  echo "## Team board (docs/team-log/BOARD.md)"
  awk '/^## Claims/{f=1} /^## Live/{f=2; print; n=0; next} f==1{print} f==2 && /^- /{if(n<8){print; n++}}' docs/team-log/BOARD.md 2>/dev/null
  if [ -f docs/testing/runs/FLAGS.md ]; then
    echo; echo "## Latest test flags (docs/testing/runs/FLAGS.md)"
    grep '^- ' docs/testing/runs/FLAGS.md | head -5
  fi
  echo; echo "Agent brief: docs/team-log/AGENT-BRIEF.md · Test ledger: docs/testing/LEDGER.md"
} > /tmp/.hw-brief.$$ 2>/dev/null
python3 -c 'import json,sys; print(json.dumps({"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":open(sys.argv[1]).read()}}))' /tmp/.hw-brief.$$
rm -f /tmp/.hw-brief.$$
exit 0
