---
title: Use createRenderEffect for Synchronous DOM Measurements
impact: MEDIUM
impactDescription: "layout flicker from deferred DOM reads"
tags: createRenderEffect, DOM, layout, synchronous
---

## Use createRenderEffect for Synchronous DOM Measurements

**Impact: MEDIUM (layout flicker from deferred DOM reads)**

When you need to measure or synchronize DOM layout before the browser paints (e.g., reading element dimensions, adjusting scroll position), use `createRenderEffect` instead of `createEffect`. Regular effects run after paint, which can cause visible flicker when the measurement drives a visual update.

**Incorrect (createEffect runs after paint — flicker visible):**

```typescript
import { createEffect, createSignal } from "solid-js"

function AutoLayout() {
  let containerRef: HTMLDivElement

  // Runs AFTER paint — user sees the un-adjusted layout briefly
  createEffect(() => {
    const height = containerRef.offsetHeight
    updateLayout(height)  // Visual adjustment flickers
  })

  return <div ref={containerRef!}>...</div>
}
```

**Correct (createRenderEffect runs during render, before paint):**

```typescript
import { createRenderEffect } from "solid-js"

function AutoLayout() {
  let containerRef: HTMLDivElement

  // Runs synchronously during render — no flicker
  createRenderEffect(() => {
    const height = containerRef.offsetHeight
    updateLayout(height)
  })

  return <div ref={containerRef!}>...</div>
}
```

**Notes:**
- `createRenderEffect` blocks rendering, so avoid heavy computation — keep it limited to DOM reads and immediate style updates
- Good use cases: scroll position sync, element dimension measurements, immediate style calculations
- Bad use cases: data fetching, complex state updates, anything async
- For one-time setup after mount, `onMount` is often a better choice

Reference: [SolidJS createRenderEffect docs](https://docs.solidjs.com/reference/secondary-primitives/create-render-effect)
