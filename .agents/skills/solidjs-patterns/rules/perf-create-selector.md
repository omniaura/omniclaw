---
title: Use createSelector for Single-Selection in Large Lists
impact: MEDIUM
impactDescription: O(1) updates instead of O(n) — only 2 items update on selection change
tags: performance, createSelector, lists, selection, fine-grained
---

## Use createSelector for Single-Selection in Large Lists

**Impact: MEDIUM (O(1) updates instead of O(n) — only 2 items update on selection change)**

Without `createSelector`, every item in a list checks `selectedId() === item.id` on selection change — all re-run. With it, only the previously-selected and newly-selected items update.

**Incorrect (O(n) — all items re-evaluate on selection change):**

```typescript
const [selectedId, setSelectedId] = createSignal<string | null>(null)

<For each={items()}>
  {(item) => (
    <div classList={{ selected: selectedId() === item.id }}>
      {item.name}
    </div>
  )}
</For>
```

**Correct (O(1) — only 2 items update):**

```typescript
import { createSelector } from "solid-js"

const [selectedId, setSelectedId] = createSignal<string | null>(null)
const isSelected = createSelector(selectedId)

<For each={items()}>
  {(item) => (
    <div classList={{ selected: isSelected(item.id) }}>
      {item.name}
    </div>
  )}
</For>
```

Use for lists with 50+ items where selection performance matters.

Reference: [SolidJS createSelector](https://docs.solidjs.com/reference/reactive-utilities/create-selector)
