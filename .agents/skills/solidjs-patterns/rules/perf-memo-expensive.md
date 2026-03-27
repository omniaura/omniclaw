---
title: Use createMemo for Expensive Derived Computations
impact: MEDIUM
tags: performance, memo, derived-state
---

## Use createMemo for Expensive Derived Computations

**Impact: MEDIUM (prevents redundant expensive recomputations)**

`createMemo` caches derived values and only recomputes when its dependencies change. Use it for filtering, sorting, or transforming large datasets. Don't use it for simple property access — the overhead isn't worth it.

**Incorrect (expensive computation runs every time it's accessed):**

```typescript
// ❌ Without memo, this runs on every access in JSX
const getFilteredItems = () =>
  allItems()
    .filter(item => item.active)
    .sort((a, b) => a.name.localeCompare(b.name))

// Every component reading getFilteredItems() triggers a re-filter
<For each={getFilteredItems()}>...</For>
<span>Count: {getFilteredItems().length}</span>
```

**Correct (createMemo caches the result):**

```typescript
import { createMemo } from "solid-js"

// ✅ Only recomputes when allItems() changes
const filteredItems = createMemo(() =>
  allItems()
    .filter(item => item.active)
    .sort((a, b) => a.name.localeCompare(b.name))
)

// Multiple accesses use cached value
<For each={filteredItems()}>...</For>
<span>Count: {filteredItems().length}</span>
```

**Don't over-memo:**

```typescript
// ❌ Unnecessary — simple property access doesn't need memoization
const name = createMemo(() => user().name)

// ✅ Just access it directly
<span>{user().name}</span>
```

**Notes:**
- `createMemo` is lazy — it only runs when read and when dependencies changed
- Chain memos for multi-step transformations: filter → sort → paginate
- Don't wrap simple getters or property access — the memo overhead costs more than it saves
