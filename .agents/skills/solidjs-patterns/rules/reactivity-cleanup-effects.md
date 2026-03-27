---
title: Always Clean Up Effects with onCleanup
impact: HIGH
impactDescription: Memory leaks from unremoved listeners, timers, subscriptions
tags: reactivity, effects, cleanup, onCleanup, memory-leak
---

## Always Clean Up Effects with onCleanup

**Impact: HIGH (memory leaks from unremoved listeners, timers, subscriptions)**

Effects re-run when dependencies change. Without cleanup, each re-run adds another listener/timer. Components unmounting without cleanup leave orphaned subscriptions.

**Incorrect (listener never removed):**

```typescript
createEffect(() => {
  window.addEventListener("resize", handleResize)
})
```

**Correct (cleanup on re-run and unmount):**

```typescript
createEffect(() => {
  window.addEventListener("resize", handleResize)
  onCleanup(() => window.removeEventListener("resize", handleResize))
})
```

Always clean up: event listeners, setInterval/setTimeout, WebSocket connections, ResizeObserver/IntersectionObserver, and any subscriptions.

Reference: [SolidJS onCleanup](https://docs.solidjs.com/reference/lifecycle/on-cleanup)
