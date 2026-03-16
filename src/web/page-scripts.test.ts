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
