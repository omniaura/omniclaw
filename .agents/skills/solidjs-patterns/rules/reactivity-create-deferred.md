---
title: Use createDeferred for Expensive Computations on Rapid Input
impact: MEDIUM
tags: reactivity, performance, debounce, search
---

## Use createDeferred for Expensive Computations on Rapid Input

**Impact: MEDIUM (prevents UI jank during rapid updates)**

`createDeferred` creates a signal that only updates when the browser is idle, preventing expensive re-computations from blocking user input. Use it instead of manual debouncing for reactive values.

**Incorrect (expensive computation runs on every keystroke):**

```typescript
const [searchTerm, setSearchTerm] = createSignal("")

// Runs expensive filter on EVERY keystroke — blocks UI
const results = createMemo(() =>
  allItems().filter(item =>
    item.name.toLowerCase().includes(searchTerm().toLowerCase())
  )
)
```

**Correct (deferred signal delays expensive computation):**

```typescript
import { createDeferred } from "solid-js"

const [searchTerm, setSearchTerm] = createSignal("")
const deferredSearch = createDeferred(searchTerm, { timeoutMs: 250 })

// Only re-runs when browser is idle or after 250ms timeout
const results = createMemo(() =>
  allItems().filter(item =>
    item.name.toLowerCase().includes(deferredSearch().toLowerCase())
  )
)
```

**Notes:**
- `createDeferred` uses `requestIdleCallback` internally, falling back to the timeout
- Keeps the input responsive while deferring expensive downstream computations
- Prefer over manual `setTimeout`/debounce patterns for reactive values
