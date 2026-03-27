---
title: Do Not Capture Signals in Closures Outside Reactive Context
impact: HIGH
impactDescription: "stale values in event handlers and callbacks"
tags: signals, closures, event handlers, stale state
---

## Do Not Capture Signals in Closures Outside Reactive Context

**Impact: HIGH (stale values in event handlers and callbacks)**

When a signal is accessed inside an effect that creates a closure (event handler, setTimeout callback), the signal value may be captured at closure creation time rather than read at execution time. Access signals inside the callback body, not during setup.

**Incorrect (signal captured during effect setup):**

```typescript
createEffect(() => {
  const currentMultiplier = multiplier()  // Captured once when effect runs

  element.addEventListener("click", () => {
    // Uses the captured value, not the current signal value
    setCount(c => c * currentMultiplier)
  })
})
```

**Correct (signal read at execution time in JSX handler):**

```typescript
// Signal is called inside the handler — reads current value on each click
<button onClick={() => setCount(c => c * multiplier())}>
  Multiply
</button>
```

**Correct (signal read at execution time in effect handler):**

```typescript
createEffect(() => {
  const handler = () => {
    // multiplier() is called when the click happens, not when effect runs
    setCount(c => c * multiplier())
  }

  element.addEventListener("click", handler)
  onCleanup(() => element.removeEventListener("click", handler))
})
```

**Notes:**
- The key distinction: `multiplier()` inside the handler body is called on each invocation; assigning `const val = multiplier()` outside the handler captures once
- This also applies to `setTimeout`, `setInterval`, and Promise `.then()` callbacks
- If the effect must re-register the handler when the signal changes (intentional tracking), accessing the signal at setup is correct but requires `onCleanup`

Reference: [SolidJS reactivity docs](https://docs.solidjs.com/concepts/reactivity)
