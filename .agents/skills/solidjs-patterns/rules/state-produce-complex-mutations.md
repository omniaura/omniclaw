---
title: Use produce() for Complex Store Mutations
impact: HIGH
tags: state, store, mutation, produce
---

## Use produce() for Complex Store Mutations

**Impact: HIGH (prevents missed reactivity on multi-field updates)**

When updating multiple fields or performing complex mutations on a store, use `produce` from `solid-js/store`. It provides an Immer-like API where you mutate a draft directly, and SolidJS translates mutations into granular reactive updates.

**Incorrect (multiple setter calls or manual spreading):**

```typescript
const [state, setState] = createStore({ items: [], count: 0, lastUpdated: "" })

// ❌ Multiple setter calls — each triggers separate updates
setState("items", items => [...items, newItem])
setState("count", c => c + 1)
setState("lastUpdated", new Date().toISOString())
```

**Correct (single produce call batches all mutations):**

```typescript
import { produce } from "solid-js/store"

const [state, setState] = createStore({ items: [], count: 0, lastUpdated: "" })

// ✅ All mutations in one batch — granular reactivity still works
setState(produce(draft => {
  draft.items.push(newItem)
  draft.count++
  draft.lastUpdated = new Date().toISOString()
}))
```

**Notes:**
- `produce` batches mutations into a single update pass
- Each property mutation still triggers only the subscribers of that property
- Especially useful for array operations (push, splice, sort) that are awkward with path-based setters
- Import from `solid-js/store`, not `solid-js`
