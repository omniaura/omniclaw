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
  (.ts / 1000 | strftime("%H:%M:%S")) as $ts |

  # Tag: container name > group name > "-"
  (.container // .group // "-") as $tag |

  # Detect agent-runner messages (from container stderr re-logged by host)
  (.msg | test("^\\[agent-runner\\]") // false) as $is_agent |

  # Strip [agent-runner] prefix for cleaner display
  (if $is_agent then .msg | sub("^\\[agent-runner\\] "; "") else .msg end) as $clean_msg |

  # Classify: op/level fields first, then regex fallback for agent-runner lines
  (if $is_agent then
    if ($clean_msg | test("^\\[msg #\\d+\\] tool=")) then "tool"
    elif ($clean_msg | test("^\\[msg #\\d+\\] text=")) then "think"
    elif ($clean_msg | test("^\\[msg #\\d+\\] type=user")) then "user"
    elif ($clean_msg | test("^\\[msg #\\d+\\] type=")) then "sdk"
    elif ($clean_msg | test("^Model:")) then "model"
    elif ($clean_msg | test("Starting query|Session initialized")) then "session"
    else "agent"
    end
  elif .level == "error" or .level == "fatal" then "error"
  elif .op == "containerSpawn" or .op == "channelConnect" or .op == "startup" then "start"
  elif .op == "containerExit" then "exit"
  elif .op == "ipcProcess" then "ipc"
  elif .op == "messageReceived" or .op == "channelSend" then "msg_in"
  elif .op == "agentRun" then "spawn"
  elif .op == "taskRun" then "task"
  elif .level == "debug" then "debug"
  else "info"
  end) as $type |

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
  else
    # Body: msg + inline metrics
    (.msg
     + (if .durationMs then " (\(.durationMs)ms)" else "" end)
     + (if .messageCount then " [\(.messageCount) msgs]" else "" end)
     + (if .turns then " turns=\(.turns)" else "" end)
     + (if .costUsd then " $\(.costUsd)" else "" end)
     + (if .exitCode then " exit=\(.exitCode)" else "" end)
     + (if .err and (.err | type) == "string" then " ERR: \(.err)" else "" end)
    )
  end) as $body |

  # ANSI color codes
  (if $type == "tool" then "CYAN"
   elif $type == "think" then "WHITE"
   elif $type == "user" then "DIM"
   elif $type == "sdk" then "DIM"
   elif $type == "model" then "MAGENTA"
   elif $type == "session" then "GREEN"
   elif $type == "msg_in" then "YELLOW"
   elif $type == "ipc" then "BLUE"
   elif $type == "spawn" then "CYAN"
   elif $type == "start" then "GREEN"
   elif $type == "exit" then "RED"
   elif $type == "error" then "RED"
   elif $type == "task" then "MAGENTA"
   elif $type == "debug" then "DIM"
   else "DIM"
   end) as $color |

  # Output: color timestamp tag body
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
