---
title: Never Mutate Store Values Directly
impact: CRITICAL
impactDescription: Mutations silently ignored — UI doesn't update
tags: reactivity, store, mutation, produce
---

## Never Mutate Store Values Directly

**Impact: CRITICAL (mutations silently ignored — UI doesn't update)**

Store proxies track reads and writes through the setter function. Direct mutation bypasses the proxy and triggers nothing.

**Incorrect (direct mutation — no update triggered):**

```typescript
const [state, setState] = createStore({ items: [] })

state.items.push(newItem) // Won't trigger reactivity!
```

**Correct (use setter or produce):**

```typescript
// Path-based setter
setState("items", items => [...items, newItem])

// Or produce for complex mutations
import { produce } from "solid-js/store"

setState(produce(state => {
  state.items.push(newItem)
  state.count++
}))
```

Reference: [SolidJS Stores](https://docs.solidjs.com/concepts/stores)
