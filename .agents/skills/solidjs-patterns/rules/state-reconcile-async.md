---
title: Use reconcile for Fine-Grained Async Updates
impact: MEDIUM-HIGH
impactDescription: Entire list re-renders instead of minimal diff on refetch
tags: state, reconcile, store, async, createAsync, fine-grained
---

## Use reconcile for Fine-Grained Async Updates

**Impact: MEDIUM-HIGH (entire list re-renders instead of minimal diff on refetch)**

When you refetch data from the server, replacing a store entirely triggers all subscribers. Use `reconcile` to diff the new data against the existing store — only changed properties trigger updates.

**Incorrect (full replacement — all subscribers update):**

```typescript
const [items, setItems] = createStore<Item[]>([])

createEffect(async () => {
  const data = await fetchItems()
  setItems(data)  // Every subscriber re-runs even if most items unchanged
})
```

**Correct (reconcile — only changed items trigger updates):**

```typescript
import { createStore, reconcile } from "solid-js/store"

const [items, setItems] = createStore<Item[]>([])

createEffect(async () => {
  const data = await fetchItems()
  setItems(reconcile(data))  // Only 'koala' (the new item) triggers an update
})
```

**Advanced: Combine createAsync with store for reactive fine-grained data:**

```typescript
const [briefsStore, setBriefs] = createStore(initialValue)
const briefs = createAsync(async () => {
  const next = await getBriefs(searchParams.search)
  setBriefs(reconcile(next))
  return briefsStore  // Return the fine-grained store, not the raw data
}, { initialValue })
```

Reference: [SolidJS reconcile](https://docs.solidjs.com/reference/store-utilities/reconcile)
