---
title: Batch Multiple Signal Updates to Prevent Intermediate Renders
impact: MEDIUM
impactDescription: "unnecessary intermediate re-renders when updating multiple signals"
tags: reactivity, batch, performance, signals
---

## Batch Multiple Signal Updates to Prevent Intermediate Renders

**Impact: MEDIUM (unnecessary intermediate re-renders when updating multiple signals)**

When updating multiple signals in event handlers or callbacks, wrap them in `batch()` to coalesce notifications. Solid automatically batches updates inside effects and store setters, but event handlers and async callbacks run outside the reactive system.

**Incorrect (each setter triggers a separate update cycle):**

```typescript
const handleSubmit = () => {
  setName("John")       // triggers re-render 1
  setEmail("j@test.com") // triggers re-render 2
  setSubmitted(true)     // triggers re-render 3
}
```

**Correct (single update cycle for all changes):**

```typescript
import { batch } from "solid-js"

const handleSubmit = () => {
  batch(() => {
    setName("John")
    setEmail("j@test.com")
    setSubmitted(true)
    // All three updates applied, then ONE re-render
  })
}
```

**Where batching is automatic (no need for manual `batch()`):**

```typescript
// Inside createEffect — already batched
createEffect(() => {
  setA(b())
  setC(d())  // batched with setA
})

// Inside store setters — already batched
setState(produce(s => {
  s.name = "John"
  s.email = "j@test.com"  // batched
}))
```

**Where you DO need manual `batch()`:**

```typescript
// Event handlers
<button onClick={() => batch(() => { setX(1); setY(2) })}>

// setTimeout / setInterval
setTimeout(() => batch(() => { setA(1); setB(2) }), 1000)

// Promise callbacks
fetch(url).then(data => batch(() => {
  setData(data)
  setLoading(false)
}))
```

**Notes:**
- `batch` returns the return value of the callback, so you can use it inline: `const result = batch(() => { ... })`
- For 2+ signal updates in the same event handler, `batch` is a no-brainer micro-optimization
- Store `setState` already batches internally — no need to wrap store updates

Reference: [SolidJS batch](https://docs.solidjs.com/reference/reactive-utilities/batch)
