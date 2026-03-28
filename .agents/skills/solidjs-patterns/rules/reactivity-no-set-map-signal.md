---
title: Use Store Instead of Set/Map with Signal
impact: CRITICAL
impactDescription: O(n) updates instead of O(1) — all subscribers re-run
tags: reactivity, set, map, store, signal, collections
---

## Use Store Instead of Set/Map with Signal

**Impact: CRITICAL (O(n) updates instead of O(1) — all subscribers re-run)**

`Set` and `Map` inside `createSignal` don't provide per-item reactivity. Changing any item forces ALL subscribers to update because the signal's identity changes.

**Incorrect (Set with signal — all subscribers update on any change):**

```typescript
const [expandedIds, setExpandedIds] = createSignal<Set<string>>(new Set());

const toggle = (id: string) => {
  setExpandedIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
};
// Every component reading expandedIds() re-renders when ANY id changes
```

**Correct (Store with record — only affected subscribers update):**

```typescript
const [expanded, setExpanded] = createStore<Record<string, boolean>>({});

const toggle = (id: string) => {
  setExpanded(id, (prev) => !prev);
};
// Only components reading expanded[specificId] update
```

Or with boolean array for index-based access:

```typescript
const [expanded, setExpanded] = createStore<boolean[]>([]);

const toggle = (index: number) => {
  setExpanded(index, (prev) => !prev);
};
// Only components reading expanded[specificIndex] update
```

Reference: [SolidJS Stores](https://docs.solidjs.com/concepts/stores)
