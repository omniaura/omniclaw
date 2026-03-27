---
title: Choose Signal vs Store Based on Update Granularity
impact: HIGH
impactDescription: Over-updating (signal for collections) or unnecessary complexity (store for primitives)
tags: state, signal, store, collections, granularity
---

## Choose Signal vs Store Based on Update Granularity

**Impact: HIGH (over-updating or unnecessary complexity)**

Signals replace the entire value on update — all subscribers re-run. Stores provide per-property reactivity. Match the primitive to your update pattern.

**Use `createSignal` when:**

```typescript
// Primitive values
const [isOpen, setIsOpen] = createSignal(false)

// Objects replaced entirely
const [position, setPosition] = createSignal({ x: 0, y: 0 })
setPosition({ x: 10, y: 20 })  // Full replacement

// Simple derived values
const [count, setCount] = createSignal(0)
```

**Use `createStore` when:**

```typescript
// Per-item updates in collections
const [expanded, setExpanded] = createStore<boolean[]>([])
setExpanded(2, true)  // Only subscribers of index 2 update

// Complex nested state with partial updates
const [state, setState] = createStore({
  users: [],
  settings: { theme: "dark", lang: "en" }
})
setState("settings", "theme", "light")  // Only theme subscribers update

// Form state with many fields
const [form, setForm] = createStore({ name: "", email: "", message: "" })
setForm("name", "Alice")  // Only name field subscribers update
```

**Quick reference:**

| Use Case | Primitive | Why |
|----------|-----------|-----|
| Single value | `createSignal` | Simple, low overhead |
| Object replaced entirely | `createSignal` | No partial updates needed |
| List with per-item changes | `createStore` | Fine-grained per-index reactivity |
| Complex nested state | `createStore` | Path-based partial updates |
| Selection tracking (multi) | `createStore<Record<string, boolean>>` | O(1) per-key updates |
| Selection tracking (single) | `createSignal` + `createSelector` | O(1) with only 2 items updating |

Reference: [SolidJS Stores](https://docs.solidjs.com/concepts/stores)
