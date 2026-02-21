#!/usr/bin/env bash
# Pretty-print OmniClaw JSON logs for human consumption.
# Usage: tail -f logs/omniclaw.log | ./scripts/log-fmt.sh

# Colors
RST='\033[0m'
DIM='\033[2m'
BOLD='\033[1m'
CYAN='\033[36m'
GREEN='\033[32m'
YELLOW='\033[33m'
MAGENTA='\033[35m'
BLUE='\033[34m'
RED='\033[31m'
WHITE='\033[37m'

jq -r --unbuffered '
  # Format timestamp as HH:MM:SS
  (.time / 1000 | strftime("%H:%M:%S")) as $ts |

  # Extract container name (short)
  (.container // null) as $ctr |

  # Detect agent-runner messages
  (.msg | test("^\\[agent-runner\\]") // false) as $is_agent |

  # Strip [agent-runner] prefix
  (if $is_agent then .msg | sub("^\\[agent-runner\\] "; "") else .msg end) as $clean_msg |

  # Classify message type for coloring
  (if $is_agent then
    # Agent-runner sub-types
    if ($clean_msg | test("^\\[msg #\\d+\\] tool=")) then "tool"
    elif ($clean_msg | test("^\\[msg #\\d+\\] text=")) then "think"
    elif ($clean_msg | test("^\\[msg #\\d+\\] type=user")) then "user"
    elif ($clean_msg | test("^\\[msg #\\d+\\] type=")) then "sdk"
    elif ($clean_msg | test("^Model:")) then "model"
    elif ($clean_msg | test("Starting query|Session initialized")) then "session"
    else "agent"
    end
  elif (.msg | test("IPC message sent")) then "ipc"
  elif (.msg | test("message stored|Reply to bot")) then "msg_in"
  elif (.msg | test("Piped messages")) then "pipe"
  elif (.msg | test("Spawning container|Launching container")) then "spawn"
  elif (.msg | test("Container .* exited|Stopped orphaned")) then "exit"
  elif (.msg | test("Startup complete|running")) then "start"
  elif (.msg | test("error|Error|failed|Failed")) then "error"
  else "info"
  end) as $type |

  # Build the agent tag from container name (lowercase, truncated)
  (if $ctr then ($ctr | ascii_downcase | .[0:16])
  else null
  end) as $tag |

  # Format agent-runner tool lines compactly
  (if $type == "tool" then
    ($clean_msg | capture("\\[msg #(?<n>\\d+)\\] tool=(?<tool>\\w+)\\s*(?<rest>.*)")) |
    "#\(.n) \(.tool) \(.rest | if length > 80 then .[0:80] + "..." else . end)"
  elif $type == "think" then
    ($clean_msg | capture("\\[msg #(?<n>\\d+)\\] text=\\\\?\"(?<text>.*)")) |
    .text | gsub("\\\\\""; "\"") | gsub("\\\\n"; " ") |
    if length > 120 then .[0:120] + "..." else . end
  elif $type == "user" then
    ($clean_msg | capture("\\[msg #(?<n>\\d+)\\] type=user")) |
    "#\(.n) (tool result)"
  elif $type == "sdk" then
    ($clean_msg | capture("\\[msg #(?<n>\\d+)\\] type=(?<t>.*)")) |
    "#\(.n) \(.t)"
  elif $type == "model" then $clean_msg
  elif $type == "session" then $clean_msg
  elif $type == "msg_in" then
    (.sender // "") as $sender |
    (.chatName // "") as $chat |
    if $sender != "" then "\($sender) → \($chat)" else $clean_msg end
  elif $type == "ipc" then
    "ipc → \(.chatJid // "?" | split(":") | last)"
  elif $type == "pipe" then
    "\(.count // "?") msg piped"
  elif $type == "spawn" then $clean_msg
  elif $type == "exit" then $clean_msg
  else $clean_msg
  end) as $body |

  # ANSI color codes embedded in output
  (if $type == "tool" then "CYAN"
   elif $type == "think" then "WHITE"
   elif $type == "user" then "DIM"
   elif $type == "sdk" then "DIM"
   elif $type == "model" then "MAGENTA"
   elif $type == "session" then "GREEN"
   elif $type == "msg_in" then "YELLOW"
   elif $type == "ipc" then "BLUE"
   elif $type == "pipe" then "DIM"
   elif $type == "spawn" then "GREEN"
   elif $type == "exit" then "RED"
   elif $type == "start" then "GREEN"
   elif $type == "error" then "RED"
   else "DIM"
   end) as $color |

  # Output: timestamp tag body color
  "\($color)\t\($ts)\t\($tag // "-")\t\($body)"
' 2>/dev/null | while IFS=$'\t' read -r color ts tag body; do
  case "$color" in
    CYAN)    c="$CYAN" ;;
    WHITE)   c="$WHITE" ;;
    DIM)     c="$DIM" ;;
    MAGENTA) c="$MAGENTA" ;;
    GREEN)   c="$GREEN" ;;
    YELLOW)  c="$YELLOW" ;;
    BLUE)    c="$BLUE" ;;
    RED)     c="$RED" ;;
    *)       c="$RST" ;;
  esac
  printf "${DIM}%s${RST} ${BOLD}%-16s${RST} ${c}%s${RST}\n" "$ts" "$tag" "$body"
done
