#!/bin/bash
# SessionStart — inject the still-live [advisory] lessons from docs/LEARNED.md.
#
# The LEARNED.md tag taxonomy makes promoted lessons self-enforcing: [audit]
# runs in npm test, [hook] IS a hook, [skill] is a step in a skill, [tool] is
# on-demand but executable. An [advisory] entry has no mechanism — it only
# works if the agent happens to read it, and an 80KB log is not reliably
# re-read. So the unpromoted entries are the ones worth putting in context at
# session start; everything else has already become a fence somewhere else.
#
# Stays silent when there is nothing to say. Always exits 0 — a lesson log
# must never block a session.

read -r -d '' INPUT || true

ROOT="${CLAUDE_PROJECT_DIR:-.}"
FILE="$ROOT/docs/LEARNED.md"
[ -f "$FILE" ] || exit 0

ENTRIES=$(grep -E '^- [0-9]{4}-[0-9]{2}-[0-9]{2} \[advisory\]:' "$FILE")
[ -n "$ENTRIES" ] || exit 0

COUNT=$(printf '%s\n' "$ENTRIES" | wc -l | tr -d ' ')

# ONE LINE PER ENTRY, NOT THE ENTRIES. Claude Code does not inject hook output
# past ~10KB — it persists it to a file and injects a 2KB preview, so dumping
# 26 full entries (40KB) delivered the first one and a half and nothing else.
# Headline = the leading **bold** claim when the entry has one, else its first
# sentence, capped either way. BUDGET caps the whole list so the count can keep
# growing without falling off the same cliff; overflow is announced, not dropped.
#
# THE HEADLINE IS THE RULE, THE BODY IS THE TRIGGER. Headlines are abstract
# ("get a reading from the device"); what makes a session recognise the lesson
# applies is the concrete thing it happened to, which lives in the body. So each
# line also carries the body's first few `code` names, skipping any the headline
# already shows. A span with two or more spaces, or over NAMELEN, is a snippet
# (`npm test 2>&1 | grep …`, `a = fi * GOLDEN + …`), not a name — it costs bytes
# and matches nothing a session will be looking at, so it is skipped.
LINES=$(printf '%s\n' "$ENTRIES" | awk -v BUDGET=8000 -v CAP=240 -v NAMES=3 -v NAMELEN=32 '
  {
    date = substr($0, 3, 10)
    text = $0; sub(/^- [0-9-]+ \[advisory\]: /, "", text)
    if (substr(text, 1, 2) == "**" && (end = index(substr(text, 3), "**")) > 0) {
      head = substr(text, 3, end - 1)
      body = substr(text, end + 4)
    } else if ((dot = index(text, ". ")) > 0 && dot <= CAP) {
      head = substr(text, 1, dot)
      body = substr(text, dot + 1)
    } else {
      head = text
      body = ""
    }
    if (length(head) > CAP) {
      body = substr(head, CAP + 1) body
      head = substr(head, 1, CAP); sub(/ [^ ]*$/, "", head); head = head "…"
    }
    names = ""; n = 0; split("", seen)
    while (n < NAMES && match(body, /`[^`]+`/)) {
      span = substr(body, RSTART, RLENGTH)
      body = substr(body, RSTART + RLENGTH)
      if (RLENGTH - 2 > NAMELEN || gsub(/ /, " ", span) > 1 || (span in seen) || index(head, span)) continue
      seen[span] = 1
      names = names (n++ ? ", " : "") span
    }
    line = "- " date ": " head (n ? " (re: " names ")" : "")
    if (used + length(line) + 1 > BUDGET) { skipped++; next }
    used += length(line) + 1
    print line
  }
  END { if (skipped) print "- (+" skipped " more past the output budget — pull the full list below)" }
')

cat <<EOF
LEARNED.md carries $COUNT unpromoted [advisory] lesson(s) — prose only, still live risk. Headlines only; before working in an area one of these names, pull its full entry (grep -F a phrase from the headline in docs/LEARNED.md). Apply them where they bite; promote them when you can:

$LINES

Full text of all of them: grep -E '^- [0-9]{4}-[0-9]{2}-[0-9]{2} \[advisory\]:' docs/LEARNED.md
EOF
exit 0
