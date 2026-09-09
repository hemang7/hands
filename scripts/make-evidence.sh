#!/usr/bin/env bash
# Produces everything under /evidence from scratch: discovery runs, replays across the outcome
# taxonomy, cross-tenant handoff + learned overrides, and the agent invoking a capability.
#
#   LLM=openai   real model-driven discovery (needs OPENAI_API_KEY)          <- what the repo ships
#   LLM=scripted offline decider, same pipeline, no key                      <- npm run demo:offline
set -euo pipefail
cd "$(dirname "$0")/.."
LLM="${LLM:-${OPENAI_API_KEY:+openai}}"; LLM="${LLM:-scripted}"
OUT="${OUT:-evidence}"
export LEGACYCORE_USER="${LEGACYCORE_USER:-teller1}" LEGACYCORE_PASSWORD="${LEGACYCORE_PASSWORD:-teller1-pass}"
H="npx tsx src/cli.ts"
RUNS=runs
rm -rf "$RUNS" capabilities
mkdir -p "$RUNS" "$OUT"

# target app
if ! curl -sf localhost:4010/__health >/dev/null; then
  npx tsx target-app/server.ts >"$RUNS/target-app.log" 2>&1 &
  TARGET_PID=$!; trap 'kill $TARGET_PID 2>/dev/null || true' EXIT
  for i in $(seq 1 30); do curl -sf localhost:4010/__health >/dev/null && break; sleep 0.5; done
fi
curl -s "localhost:4010/__chaos?tenant=alpha&set=none" >/dev/null; curl -s "localhost:4010/__chaos?tenant=beta&set=none" >/dev/null

step() { echo; echo "################  $*"; echo; }

step "1. DISCOVERY (llm=$LLM): read-only lookup capability"
$H discover --id lookup_member_balance --llm "$LLM" --run-id 01-discovery-lookup_member_balance --pii memberId \
  --goal "Look up member {memberId} and read their current share savings balance." --input memberId=10001

step "2. DISCOVERY (llm=$LLM): flow with a form, a review screen and an irreversible commit (allowed for this run)"
$H discover --id open_sub_account --llm "$LLM" --run-id 02-discovery-open_sub_account --pii memberId --allow-irreversible --max-steps 30 \
  --goal "Use Member Inquiry to look up member {memberId}. On their member detail screen, use the button that opens a new sub-account (do not use the Transactions menu item, which is unrelated). Set the account type to {accountType}, the nickname to {nickname}, and the initial deposit to {deposit} dollars. Review the details, confirm the posting, and stop on the screen that shows the host confirmation number." \
  --input memberId=10002 --input "accountType=Club Savings" --input "nickname=VACATION FUND" --input deposit=25.00

step "3. REPLAY: same artifact, different input, no model"
$H replay lookup_member_balance --input memberId=10003 --run-id 03-replay-success

step "4. REPLAY: business outcome, not a failure (record not found)"
$H replay lookup_member_balance --input memberId=99999 --run-id 04-replay-outcome-not-found || true

step "5. REPLAY: contract violation rejected before touching the UI"
$H replay lookup_member_balance --input memberId=12 --run-id 05-replay-invalid-input || true

step "6. REPLAY: recoverable - session expiry mid-flow (re-auth + restart)"
$H replay lookup_member_balance --input memberId=10001 --inject timeout --run-id 06-replay-recover-session-expired

step "7. REPLAY: recoverable - interstitial system notice (dismiss + retry)"
$H replay lookup_member_balance --input memberId=10002 --inject interstitial --run-id 07-replay-recover-interstitial

step "8. REPLAY: recoverable - slow host (settle timeout tightened to 1.5s to provoke it)"
$H replay lookup_member_balance --input memberId=10001 --inject slow --settle-ms 1500 --run-id 08-replay-recover-slow-load

step "9. REPLAY: hard failure - application error page (screenshot + DOM snapshot bundle)"
$H replay lookup_member_balance --input memberId=10001 --inject crash --run-id 09-replay-hard-app-error || true

step "10. REPLAY on tenant beta: same artifact, drifted labels/frames, human handoff on the live session"
$H replay lookup_member_balance --input memberId=10001 --tenant beta --operator scripted:tenant-beta-operator --run-id 10-replay-tenant-beta-handoff

step "11. LEARN tenant overrides from run 10 (drift + what the operator did) -> v2"
$H learn-overrides lookup_member_balance --from-run 10-replay-tenant-beta-handoff

step "12. REPLAY v2 on tenant beta: clean, no drift, no intervention"
$H replay lookup_member_balance --input memberId=10002 --tenant beta --run-id 12-replay-tenant-beta-with-overrides

step "13. REPLAY: escalation where the operator aborts (no operator answer path is the same with a timeout)"
$H replay lookup_member_balance --input memberId=10001 --tenant beta --version 1 --operator scripted:abort --run-id 13-replay-escalated-abort || true

if [ -f capabilities/open_sub_account.v1.json ]; then
step "14. REPLAY open_sub_account without approval: irreversible step escalates, operator commits by hand"
$H replay open_sub_account --input memberId=10003 --input "accountType=Money Market" --input "nickname=TAX RESERVE" --input deposit=40 \
  --operator scripted:confirm-commit --run-id 14-replay-irreversible-needs-approval || true

step "15. REPLAY open_sub_account: business outcome PERMISSION_DENIED for a restricted member"
$H replay open_sub_account --input memberId=55555 --input "accountType=Club Savings" --input "nickname=HOLIDAY" --input deposit=10 --run-id 15-replay-outcome-permission-denied || true

step "16. REPLAY open_sub_account: validation error from the app surfaces as a business outcome"
$H replay open_sub_account --input memberId=10003 --input "accountType=Club Savings" --input "nickname=AB" --input deposit=1 --run-id 16-replay-outcome-validation-error || true

step "17. APPROVE + REPLAY with caller confirm: the irreversible step is allowed to run unattended"
$H approve open_sub_account
$H replay open_sub_account --input memberId=10003 --input "accountType=Club Savings" --input "nickname=RAINY DAY" --input deposit=15 --confirm --run-id 17-replay-irreversible-approved-confirmed
fi

step "18. CATALOG: capabilities as an agent-facing tool surface"
$H catalog | tee "$RUNS/catalog.txt"
$H catalog --json > "$RUNS/catalog-tools.json"

if [ "$LLM" = openai ]; then
step "19. AGENT DEMO: an LLM answers a question by invoking a capability (replay, no model in the UI loop)"
$H agent "What is the share savings balance of member 10003, and does member 99999 exist?" | tee "$RUNS/agent-demo.txt"
fi

step "collect into $OUT/"
rm -rf "$OUT"/[0-9]*-* "$OUT"/capabilities "$OUT"/catalog* "$OUT"/agent-demo*
cp -r "$RUNS"/[0-9]*-* "$OUT"/
cp -r capabilities "$OUT"/capabilities
cp "$RUNS"/catalog.txt "$RUNS"/catalog-tools.json "$OUT"/ 2>/dev/null || true
cp "$RUNS"/agent-demo.txt "$OUT"/ 2>/dev/null || true
cp -r "$RUNS"/agent-demo-* "$OUT"/ 2>/dev/null || true
echo; echo "evidence written to $OUT/"; ls "$OUT"
