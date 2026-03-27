---
title: Access Signals/Stores Directly in JSX
impact: CRITICAL
impactDescription: Silent tracking loss — UI stops reacting to changes
tags: reactivity, tracking, signals, stores, jsx
---

## Access Signals/Stores Directly in JSX

**Impact: CRITICAL (silent tracking loss — UI stops reacting to changes)**

Signal and store access must happen inside the reactive context (JSX, createEffect, createMemo), not inside helper functions called from JSX. The reactive system tracks where signals are read — if they're read inside a plain function, the tracking happens there, not in JSX.

**Incorrect (access happens in helper, outside reactive JSX context):**

```typescript
const [expanded, setExpanded] = createStore<boolean[]>([])

const isExpanded = (index: number) => expanded[index] === true

// In JSX — this WON'T update when expanded changes!
<Show when={isExpanded(index())}>
  <Content />
</Show>
```

**Correct (access happens directly in JSX reactive context):**

```typescript
<Show when={expanded[index()]}>
  <Content />
</Show>
```

Similarly for signals:

```typescript
// ❌ Access in helper
const getCount = () => count()
<div>{getCount()}</div>  // Won't update!

// ✅ Access directly in JSX
<div>{count()}</div>
```

Reference: [SolidJS Reactivity](https://docs.solidjs.com/concepts/intro-to-reactivity)
