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
});
