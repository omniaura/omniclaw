#!/usr/bin/env bash
# Warn when docs/ROADMAP.md "Planned Work" sections reference closed/merged
# issues without an explicit `(closed; ...)` or `(follow-on ...)` annotation.
#
# Usage: bash scripts/check-roadmap-refs.sh
# Requires: gh CLI authenticated against omniaura/omniclaw.
# Non-zero exit if a stale reference is found.

set -u

ROADMAP="${ROADMAP:-docs/ROADMAP.md}"
REPO="${REPO:-omniaura/omniclaw}"

if [[ ! -f "$ROADMAP" ]]; then
  echo "error: $ROADMAP not found (run from repo root or set ROADMAP=)" >&2
  exit 2
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "error: gh CLI not found in PATH" >&2
  exit 2
fi

# Extract the Planned Work region: between "## Planned Work" and the next "## " header.
planned=$(awk '
  /^## Planned Work[[:space:]]*$/ { capture=1; next }
  capture && /^## / { exit }
  capture { print }
' "$ROADMAP")

if [[ -z "$planned" ]]; then
  echo "error: could not locate '## Planned Work' section in $ROADMAP" >&2
  exit 2
fi

# Pull every #NNN reference, dedup, ignore tiny numbers (footnote-like).
refs=$(printf '%s\n' "$planned" \
  | grep -oE '#[0-9]+' \
  | sort -u \
  | sed 's/^#//' \
  | awk '$1 >= 1')

stale=()
for n in $refs; do
  state=$(gh issue view "$n" -R "$REPO" --json state --jq '.state' 2>/dev/null || true)
  if [[ -z "$state" ]]; then
    # Might be a PR ref instead of an issue.
    state=$(gh pr view "$n" -R "$REPO" --json state --jq '.state' 2>/dev/null || true)
  fi
  case "$state" in
    CLOSED|MERGED)
      # Allow if the line containing this ref carries an explicit closed/follow-on annotation
      # or refers to the closed item in past tense (shipped/merged/completed/delivered/closed).
      if printf '%s\n' "$planned" \
           | grep -E "#${n}\b" \
           | grep -qiE '\b(closed|follow-on|merged|shipped|completed|delivered|closes)\b'; then
        continue
      fi
      stale+=("#$n ($state)")
      ;;
  esac
done

if (( ${#stale[@]} > 0 )); then
  echo "ROADMAP.md Planned Work references the following closed/merged items without an explicit annotation:" >&2
  printf '  - %s\n' "${stale[@]}" >&2
  echo "Fix: move the section to 'Completed Recently', or annotate the line with '(closed; follow-on ...)'." >&2
  exit 1
fi

echo "ROADMAP.md Planned Work references look clean."
