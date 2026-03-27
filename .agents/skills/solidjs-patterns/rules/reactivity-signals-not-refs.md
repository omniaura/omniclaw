---
title: Use Signals for Timing-Sensitive State, Not Refs
impact: CRITICAL
impactDescription: Closures capture stale ref values — race conditions and bugs
tags: reactivity, signals, refs, closures, timing
---

## Use Signals for Timing-Sensitive State, Not Refs

**Impact: CRITICAL (closures capture stale ref values — race conditions and bugs)**

Plain JS variables (refs) are captured when closures are created. Signals are read at execution time. For any state that must reflect the current value inside setTimeout, Promise callbacks, or event handlers, use signals.

**Incorrect (ref value captured at scheduling time):**

```typescript
let isPaginating = false

const handleLoadMore = () => {
  isPaginating = true
  fetchNextPage()
}

createEffect(() => {
  const timeout = setTimeout(() => {
    if (!isPaginating) {  // ❌ Reads OLD value from closure
      scrollToBottom()     // Scrolls even though isPaginating was set!
    }
  }, 100)
  return () => clearTimeout(timeout)
})
```

**Correct (signal read at execution time):**

```typescript
const [isPaginating, setIsPaginating] = createSignal(false)

const handleLoadMore = () => {
  setIsPaginating(true)
  fetchNextPage()
}

createEffect(() => {
  const timeout = setTimeout(() => {
    if (!isPaginating()) {  // ✅ Reads CURRENT value
      scrollToBottom()
    }
  }, 100)
  return () => clearTimeout(timeout)
})
```

**Key insight**: Signals are *read* when called. Refs are *captured* when closures are created.

Reference: [SolidJS Signals](https://docs.solidjs.com/concepts/signals)
