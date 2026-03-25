import { onCleanup, onMount } from 'solid-js';

interface ResizeHandleProps {
  onResize: (deltaX: number) => void;
  side: 'left' | 'right';
}

export default function ResizeHandle(props: ResizeHandleProps) {
  let handleRef: HTMLDivElement | undefined;

  onMount(() => {
    if (!handleRef) return;

    let startX = 0;
    let dragging = false;

    function onMouseDown(e: MouseEvent) {
      e.preventDefault();
      startX = e.clientX;
      dragging = true;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    }

    function onMouseMove(e: MouseEvent) {
      if (!dragging) return;
      const delta = e.clientX - startX;
      startX = e.clientX;
      props.onResize(props.side === 'right' ? -delta : delta);
    }

    function onMouseUp() {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }

    handleRef.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    onCleanup(() => {
      handleRef?.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    });
  });

  return (
    <div
      ref={handleRef}
      class="w-1.5 cursor-col-resize flex items-center justify-center hover:bg-border-bright/50 transition-colors shrink-0"
    >
      <div class="w-0.5 h-8 bg-border rounded" />
    </div>
  );
}
