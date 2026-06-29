import { describe, expect, it } from 'bun:test';

import { allPageScripts } from './page-scripts.js';

describe('dashboard page script', () => {
  it('retries layout initialization after hidden or zero-size mounts', () => {
    const script = allPageScripts().dashboard;

    expect(script).toContain(
      'window.addEventListener("pageshow",refreshLayout);',
    );
    expect(script).toContain(
      'document.addEventListener("visibilitychange",refreshLayout);',
    );
    expect(script).toContain('if(!W||!H){');
    expect(script).toContain('if(resize()&&(!hadSize||!hasFitted))fitView();');
  });
});

describe('logs page script', () => {
  it('re-syncs the full logs view when sidebar logs replay after reload', () => {
    const script = allPageScripts().logs;
    const sidebarObserverStart = script.indexOf(
      'sidebarObs=new MutationObserver(function(mutations){',
    );
    const sidebarObserverEnd = script.indexOf(
      'sidebarObs.observe(sidebar,{childList:true});',
      sidebarObserverStart,
    );
    const sidebarObserverBlock = script.slice(
      sidebarObserverStart,
      sidebarObserverEnd,
    );

    expect(script).toContain('function syncFromSidebar(){');
    expect(script).toContain('output.innerHTML="";');
    expect(script).toContain(
      'sidebarObs=new MutationObserver(function(mutations){',
    );
    expect(sidebarObserverBlock).toContain('needsFullSync');
    expect(sidebarObserverBlock).toContain('added[j].cloneNode(true)');
    expect(sidebarObserverBlock).toContain('syncFromSidebar();');
    expect(sidebarObserverBlock).not.toContain('updateCount();');
    expect(sidebarObserverBlock).not.toContain(
      'output.scrollTop=output.scrollHeight;',
    );
    expect(script).toContain(
      'window.__cleanup=function(){obs.disconnect();if(sidebarObs)sidebarObs.disconnect();clearTimeout(searchTimer);};',
    );
  });
});

describe('tasks page script', () => {
  it('keeps friendly schedule labels when tasks refresh from the API', () => {
    const script = allPageScripts().tasks;

    expect(script).toContain('function scheduleLabel(type,value){');
    expect(script).toContain(
      'var sl=scheduleLabel(task.schedule_type,task.schedule_value);',
    );
    expect(script).toContain(
      "+'<span class=\"sched-label\">'+window.__esc(sl)+'</span></td>'",
    );
  });

  it('preserves one-shot datetime-local wall-clock values', () => {
    const script = allPageScripts().tasks;

    expect(script).toContain('return dtVal;');
    expect(script).toContain('dtEl.value=toDatetimeLocalValue(rawValue);');
    expect(script).toContain('function dateToLocalDatetimeValue(d){');
    expect(script).not.toContain('new Date(dtVal).toISOString()');
    expect(script).not.toContain('d.toISOString().slice(0,16)');
  });

  it('keeps task form schedule controls and submit buttons resettable', () => {
    const script = allPageScripts().tasks;

    expect(script).toContain('ctrl.disabled=!active;');
    expect(script).toContain(
      'document.getElementById("tmc-schedule-type").value="cron";',
    );
    expect(script).toContain('sb.disabled=false;');
  });

  it('mirrors active stat rollups when refreshing', () => {
    const script = allPageScripts().tasks;

    expect(script).toContain(
      'function formatActiveTaskStats(active,running,overdue){',
    );
    expect(script).toContain('fetch("/api/ipc/queue")');
    expect(script).toContain(
      'var activeLabel=formatActiveTaskStats(active,running,overdue);',
    );
    expect(script).toContain(
      "+(executing>0?'<span class=\"tasks-stat stat-executing\">'+executing+' executing</span>':'')",
    );
    expect(script).toContain(
      "+'<span class=\"tasks-stat stat-active\">'+activeLabel+'</span>'",
    );
    expect(script).toContain('if(isFinite(nr)&&nr<now)overdue++;');
  });

  it('sends the optional preprocess script on create and edit', () => {
    const script = allPageScripts().tasks;

    // Create payload includes the trimmed preprocess field
    expect(script).toContain(
      'preprocess_script:document.getElementById("tmc-preprocess").value.trim()',
    );
    // Edit payload includes the trimmed preprocess field
    expect(script).toContain(
      'preprocess_script:document.getElementById("tme-preprocess").value.trim()',
    );
    // Edit modal hydrates the field from the loaded task (blank when unset)
    expect(script).toContain(
      'document.getElementById("tme-preprocess").value=t.preprocess_script||"";',
    );
  });
});

describe('context page script', () => {
  it('sanitizes rendered markdown before injecting preview HTML', () => {
    const script = allPageScripts().context;

    expect(script).toContain('var rendered=marked.parse(content);');
    expect(script).toContain(
      'el.innerHTML=window.__sanitizeHtml?window.__sanitizeHtml(rendered):rendered;',
    );
  });
});

describe('network page script', () => {
  it('keeps remote log controls wired after peer refreshes', () => {
    const script = allPageScripts().network;

    expect(script).toContain(
      'if(action==="logs"){startRemoteLogs(id);return;}',
    );
    expect(script).toContain('data-network-action="logs"');
    expect(script).toContain('function startRemoteLogs(instanceId){');
    expect(script).toContain(
      'new EventSource("/api/discovery/peers/"+encodeURIComponent(instanceId)+"/logs")',
    );
    expect(script).toContain('function stopRemoteLogs(silent){');
    expect(script).toContain(
      'window.__cleanup=function(){if(pollTimer)clearInterval(pollTimer);stopRemoteLogs(true);};',
    );
  });

  it('routes refreshed peer rows through renderPeerOnlineCell so the last-seen chip survives /api/discovery/peers refreshes', () => {
    const script = allPageScripts().network;

    // Both helpers must be defined client-side.
    expect(script).toContain('function formatPeerLastSeen(lastSeen,nowMs){');
    expect(script).toContain('function renderPeerOnlineCell(peer){');
    // renderPeerRows must use the new cell renderer instead of inlining the
    // bare dot — otherwise refreshPeers() rebuilds rows without the chip.
    expect(script).toContain("+'<td>'+renderPeerOnlineCell(peer)+'</td>'");
    expect(script).not.toContain(
      "+'<td>'+(peer.online?'<span style=\"color:var(--green)\">●</span>':'<span style=\"color:var(--text-muted)\">○</span>')+'</td>'",
    );
  });

  it('client formatPeerLastSeen matches the server thresholds (sub-minute, hour, day, 30d, future-clamp)', () => {
    const script = allPageScripts().network;
    const start = script.indexOf('function formatPeerLastSeen(');
    expect(start).toBeGreaterThan(-1);
    // Capture the function definition through its closing brace + Date fallback line.
    const end = script.indexOf(
      'return new Date(t).toLocaleDateString();',
      start,
    );
    expect(end).toBeGreaterThan(-1);
    const body = script.slice(start, end);

    expect(body).toContain('if(!lastSeen)return "";');
    expect(body).toContain('if(isNaN(t))return "";');
    // Future-dated timestamps clamp to "now" (Math.max(0, now - t)).
    expect(body).toContain('var diff=Math.max(0,now-t);');
    expect(body).toContain('if(diff<60000)return "now";');
    expect(body).toContain(
      'if(diff<3600000)return Math.floor(diff/60000)+"m ago";',
    );
    expect(body).toContain(
      'if(diff<86400000)return Math.floor(diff/3600000)+"h ago";',
    );
    expect(body).toContain(
      'if(diff<30*86400000)return Math.floor(diff/86400000)+"d ago";',
    );
  });

  it('renderPeerOnlineCell omits the chip when online or when lastSeen is missing, and escapes the title attribute', () => {
    const script = allPageScripts().network;
    const start = script.indexOf('function renderPeerOnlineCell(peer){');
    expect(start).toBeGreaterThan(-1);
    const end = script.indexOf('function renderPeerRows(peers){', start);
    expect(end).toBeGreaterThan(-1);
    const body = script.slice(start, end);

    // Online → bare dot, no chip lookup.
    expect(body).toContain('if(peer.online)return dot;');
    // Offline + no lastSeen (or unparseable) → bare dot.
    expect(body).toContain('if(!rel)return dot;');
    // Title attribute escapes the raw ISO so a crafted lastSeen can't break out of the tag.
    expect(body).toContain('window.__esc(peer.lastSeen)');
    expect(body).toContain('class="peer-last-seen"');
    expect(body).toContain('window.__esc(rel)');
  });
});

describe('conversations page script', () => {
  it('loads marked library for markdown rendering', () => {
    const script = allPageScripts().conversations;
    expect(script).toContain('function loadMarked(){');
    expect(script).toContain('function configureMarked(){');
    expect(script).toContain('marked.setOptions({breaks:true,gfm:true})');
    expect(script).toContain('loadMarked();');
  });

  it('renders messages with markdown via renderMd helper', () => {
    const script = allPageScripts().conversations;
    expect(script).toContain('function renderMd(text){');
    expect(script).toContain('marked.parse(window.__esc(text))');
    expect(script).toContain('msg-md');
  });

  it('sanitizes markdown output to block javascript: links and raw HTML', () => {
    const script = allPageScripts().conversations;
    // After markdown parsing, the result must pass through the existing
    // allowlist sanitizer so anchors with javascript: hrefs are stripped.
    expect(script).toContain(
      'window.__sanitizeHtml?window.__sanitizeHtml(html):html',
    );
    // Pre-markdown escape must still happen to keep raw HTML out of marked.
    expect(script).toContain('marked.parse(window.__esc(text))');
  });

  it('subscribes to SSE for live message updates', () => {
    const script = allPageScripts().conversations;
    expect(script).toContain('function startLiveSse(){');
    expect(script).toContain(
      'new EventSource("/api/events?channels=messages")',
    );
    expect(script).toContain('function appendLiveMessage(msg){');
    expect(script).toContain('startLiveSse();');
  });

  it('auto-scrolls only when user is near the bottom', () => {
    const script = allPageScripts().conversations;
    expect(script).toContain(
      'container.scrollHeight-container.scrollTop-container.clientHeight<60',
    );
    expect(script).toContain(
      'if(atBottom)container.scrollTop=container.scrollHeight',
    );
  });

  it('reconnects SSE after errors with backoff', () => {
    const script = allPageScripts().conversations;
    expect(script).toContain('liveSse.onerror=function(){');
    expect(script).toContain('setTimeout(startLiveSse,5000)');
  });

  it('updates chat list timestamp on live messages', () => {
    const script = allPageScripts().conversations;
    expect(script).toContain('function updateChatListTime(jid,timestamp){');
  });

  it('renders the SSE chat-row update as a relative bucket, not a locale date', () => {
    // Regression guard for the PR #811 review: the server-rendered sidebar
    // ships relative labels ("5m ago"), but if the live SSE handler overwrites
    // the same cell with `new Date(timestamp).toLocaleString()`, the row flips
    // back to a long absolute string the moment a new message arrives. The
    // handler must mirror the server bucket logic and target the dedicated
    // .chat-time element rather than the generic second .chat-meta.
    const script = allPageScripts().conversations;
    expect(script).toContain('function chatRelTime(iso){');
    expect(script).toContain('"now"');
    expect(script).toContain('"m ago"');
    expect(script).toContain('"h ago"');
    expect(script).toContain('"d ago"');
    expect(script).toContain('item.querySelector(".chat-time")');
    expect(script).toContain('timeEl.textContent=chatRelTime(timestamp)');
    // Absolute time is preserved as the hover title so operators can still
    // recover the exact wall-clock time on demand.
    expect(script).toContain('function chatAbsTime(iso){');
    expect(script).toContain('if(isNaN(d.getTime()))return ""');
    expect(script).toContain('var absTime=chatAbsTime(timestamp)');
    expect(script).toContain('if(absTime)timeEl.setAttribute("title",absTime)');
    expect(script).toContain('else timeEl.removeAttribute("title")');
    // The old behaviour (overwriting the second .chat-meta with a locale
    // string) must be gone, otherwise the bug returns.
    expect(script).not.toContain(
      'metas[1].textContent=new Date(timestamp).toLocaleString()',
    );
    expect(script).not.toContain(
      'timeEl.setAttribute("title",new Date(timestamp).toLocaleString())',
    );
  });
});

describe('system page script', () => {
  it('refreshes peer health tile from /api/health poll', () => {
    const script = allPageScripts().system;

    expect(script).toContain('fetch("/api/health")');
    expect(script).toContain('if(h.peers){');
    expect(script).toContain('getElementById("sys-peers-discovery")');
    expect(script).toContain('getElementById("sys-peers-total")');
    expect(script).toContain('getElementById("sys-peers-online")');
    expect(script).toContain('getElementById("sys-peers-trusted")');
    expect(script).toContain('getElementById("sys-peers-trusted-offline")');
    expect(script).toContain('getElementById("sys-peers-pending-requests")');
  });

  it('refreshes peer by_status breakdown for every PeerStatus key', () => {
    const script = allPageScripts().system;

    expect(script).toContain(
      'var pstats=["trusted","pending","discovered","revoked"];',
    );
    expect(script).toContain(
      'el=document.getElementById("sys-peers-status-"+pk);',
    );
    expect(script).toContain(
      'if(el)el.textContent=String(h.peers.by_status[pk]||0);',
    );
  });

  it('mirrors the renderDiscoveryState logic when toggling the discovery cell', () => {
    const script = allPageScripts().system;

    expect(script).toContain(
      '(!h.peers.discovery_available?"unavailable":(h.peers.discovery_active?"active":"disabled"))',
    );
  });

  it('refreshes queue card scalar fields from /api/health poll', () => {
    const script = allPageScripts().system;

    expect(script).toContain('if(h.queue){');
    expect(script).toContain('getElementById("sys-queue-groups")');
    expect(script).toContain('getElementById("sys-queue-processing")');
    expect(script).toContain('getElementById("sys-queue-running-tasks")');
    expect(script).toContain('getElementById("sys-queue-pending-messages")');
    expect(script).toContain('getElementById("sys-queue-pending-tasks")');
    expect(script).toContain('getElementById("sys-queue-retrying")');
    expect(script).toContain('getElementById("sys-queue-total-retries")');
    expect(script).toContain('getElementById("sys-queue-max-retries")');
  });

  it('renders the longest-running placeholder em-dash when no task is running', () => {
    const script = allPageScripts().system;

    expect(script).toContain('getElementById("sys-queue-longest-running")');
    // Mirrors the server-side ternary in renderSystemContent so /system and
    // the poll loop agree when no task is running.
    expect(script).toContain(
      'h.queue.running_tasks>0?fmtDur(h.queue.longest_running_task_ms):"—"',
    );
  });

  it('refreshes message_lane_reasons rollup for every reason key', () => {
    const script = allPageScripts().system;

    expect(script).toContain('if(h.queue.message_lane_reasons){');
    expect(script).toContain(
      'var mreasons=Object.keys(h.queue.message_lane_reasons);',
    );
    expect(script).toContain(
      'el=document.getElementById("sys-queue-msg-reason-"+mrk);',
    );
    expect(script).toContain(
      'if(el)el.textContent=String(h.queue.message_lane_reasons[mrk]||0);',
    );
  });

  it('refreshes task_lane_reasons rollup for every reason key', () => {
    const script = allPageScripts().system;

    expect(script).toContain('if(h.queue.task_lane_reasons){');
    expect(script).toContain(
      'var treasons=Object.keys(h.queue.task_lane_reasons);',
    );
    expect(script).toContain(
      'el=document.getElementById("sys-queue-task-reason-"+trk);',
    );
    expect(script).toContain(
      'if(el)el.textContent=String(h.queue.task_lane_reasons[trk]||0);',
    );
  });
});

describe('agent-detail page script', () => {
  it('preserves the SSR disabled badge by skipping queue-derived renders', () => {
    const script = allPageScripts()['agent-detail'];

    // /api/ipc/queue has no enabled flag, so the poll cannot re-derive the
    // disabled override. update() must bail when the badge is already
    // disabled and wait for the enable button's full page reload.
    expect(script).toContain(
      'if(statusEl.getAttribute("data-exec-status")==="disabled")return;',
    );
  });
});
