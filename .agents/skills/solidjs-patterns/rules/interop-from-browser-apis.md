---
title: Use from() to Bridge Browser APIs into Reactive Signals
impact: LOW
impactDescription: Clean reactive integration with matchMedia, ResizeObserver, WebSocket
tags: interop, from, browser-api, matchMedia, observer, subscription
---

## Use from() to Bridge Browser APIs into Reactive Signals

**Impact: LOW (clean reactive integration with matchMedia, ResizeObserver, WebSocket)**

`from()` converts any subscribe/unsubscribe pattern into a Solid signal with automatic cleanup. Use it for browser APIs, WebSockets, or any external subscription.

**Incorrect (one-shot check, won't react to changes):**

```typescript
createEffect(() => {
  const isSmall = window.matchMedia("(max-width: 768px)").matches
  if (isSmall) doSomething()  // Only checks once
})
```

**Correct (reactive, updates when condition changes):**

```typescript
function useMediaQuery(query: string): Accessor<boolean | undefined> {
  return from((set) => {
    if (typeof window === "undefined") {
      set(false)
      return () => {}
    }
    const media = window.matchMedia(query)
    set(media.matches)
    const listener = () => set(media.matches)
    media.addEventListener("change", listener)
    return () => media.removeEventListener("change", listener)
  })
}

// Usage — reactive!
const isWidescreen = useMediaQuery("(min-width: 1280px)")
```

**Key rules for `from`:**
1. Always return a cleanup function (even if empty)
2. Return type is `T | undefined` until first `set()` call
3. Check `typeof window` for SSR safety

Reference: [SolidJS from()](https://docs.solidjs.com/reference/reactive-utilities/from)
