---
title: Use on() to Break Circular Dependencies
impact: HIGH
impactDescription: Infinite effect loops from reading and writing the same signal
tags: reactivity, on, untrack, circular, effects, dependencies
---

## Use on() to Break Circular Dependencies

**Impact: HIGH (infinite effect loops from reading and writing the same signal)**

When an effect reads a signal it also writes, it creates a circular dependency. Use `on()` to explicitly declare which signals trigger the effect — the callback body runs in an untracked context.

**Incorrect (circular dependency — effect triggers itself):**

```typescript
createEffect(() => {
  const status = streamStatusQuery.data; // tracked
  if (!status) return;
  if (status.isStreaming && !isWaitingForResponse()) {
    // tracked!
    setIsWaitingForResponse(true); // triggers re-run!
  }
});
```

**Correct (on() — only track query data, not the signal being written):**

```typescript
createEffect(
  on(
    () => streamStatusQuery.data,
    (status) => {
      if (!status) return;
      // isWaitingForResponse() read here is UNTRACKED
      if (status.isStreaming && !isWaitingForResponse()) {
        setIsWaitingForResponse(true);
      }
    },
    { defer: true },
  ),
);
```

**Use `untrack()` for surgical opt-out** when most reads should track but one shouldn't:

```typescript
createEffect(() => {
  const value = importantSignal(); // tracked
  const context = untrack(() => otherSignal()); // NOT tracked
  process(value, context);
});
```

Reference: [SolidJS on()](https://docs.solidjs.com/reference/reactive-utilities/on)
