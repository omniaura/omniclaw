---
title: Use renderHook for Testing Custom Hooks
impact: LOW
impactDescription: "boilerplate-heavy tests or missing reactive context"
tags: testing, renderHook, hooks, vitest
---

## Use renderHook for Testing Custom Hooks

**Impact: LOW (boilerplate-heavy tests or missing reactive context)**

When testing custom hooks (functions that use `createSignal`, `createEffect`, etc.), use `renderHook` from `@solidjs/testing-library` instead of manually setting up `createRoot`. It provides a proper reactive and rendering context and returns the hook's result for assertions.

**Incorrect (manual createRoot boilerplate):**

```typescript
import { createRoot } from "solid-js"

it("increments counter", () => {
  createRoot(dispose => {
    const counter = useCounter()
    expect(counter.count()).toBe(0)
    counter.increment()
    expect(counter.count()).toBe(1)
    dispose()
  })
})
```

**Correct (renderHook handles the reactive context):**

```typescript
import { renderHook } from "@solidjs/testing-library"

it("increments counter", () => {
  const { result } = renderHook(() => useCounter())

  expect(result.count()).toBe(0)
  result.increment()
  expect(result.count()).toBe(1)
})
```

**Notes:**
- `renderHook` creates both a reactive owner and a DOM rendering context, which some hooks require
- The `result` object is whatever the hook function returns
- Use `createRoot` directly when testing pure reactive logic with no DOM needs (stores, signals)
- `renderHook` automatically cleans up the reactive scope when the test ends

Reference: [Solid Testing Library docs](https://github.com/solidjs/solid-testing-library)
