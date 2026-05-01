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
});
