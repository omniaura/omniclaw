---
title: Don't Assume Effect Execution Order
impact: HIGH
impactDescription: Intermittent bugs from effects running in unexpected order
tags: reactivity, effects, ordering, dependencies
---

## Don't Assume Effect Execution Order

**Impact: HIGH (intermittent bugs from effects running in unexpected order)**

Effects run when their dependencies change, not in source code order. Two effects with different dependencies may execute in any order.

**Incorrect (assuming first effect runs before second):**

```typescript
createEffect(() => {
  wasPaginatingRef.current = props.isFetchingNextPage
})

createEffect(() => {
  if (!wasPaginatingRef.current) {
    scrollToBottom()  // ❌ May run BEFORE the first effect!
  }
})
```

**Correct (single effect or shared signal):**

```typescript
// Best: single effect with all logic
createEffect(() => {
  if (props.isFetchingNextPage) return
  scrollToBottom()
})

// Alternative: shared signal state
const [isBlocked, setIsBlocked] = createSignal(false)

createEffect(() => {
  setIsBlocked(props.isFetchingNextPage)
})

createEffect(() => {
  if (isBlocked()) return
  scrollToBottom()
})
```

Reference: [SolidJS Effects](https://docs.solidjs.com/concepts/effects)
