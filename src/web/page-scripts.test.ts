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

    expect(script).toContain('function syncFromSidebar(){');
    expect(script).toContain('output.innerHTML="";');
    expect(script).toContain('sidebarObs=new MutationObserver(function(){');
    expect(script).toContain('syncFromSidebar();');
    expect(script).toContain(
      'window.__cleanup=function(){obs.disconnect();if(sidebarObs)sidebarObs.disconnect();clearTimeout(searchTimer);};',
    );
  });
});
