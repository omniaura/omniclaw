---
title: Derive State with Functions or Memos, Not Effects
impact: HIGH
impactDescription: "unnecessary re-renders, potential infinite loops, and harder-to-trace data flow"
tags: reactivity, derived state, effects, anti-pattern
---

## Derive State with Functions or Memos, Not Effects

**Impact: HIGH (unnecessary re-renders, potential infinite loops, and harder-to-trace data flow)**

When one value depends on another, derive it as a plain function or `createMemo` — never synchronize signals with `createEffect`. Effects are for side effects (DOM manipulation, logging, network requests), not for keeping state in sync.

**Incorrect (syncing state with an effect):**

```typescript
const [firstName, setFirstName] = createSignal("John")
const [lastName, setLastName] = createSignal("Doe")
const [fullName, setFullName] = createSignal("")

// BAD: effect creates a hidden data flow, extra signal, extra re-render
createEffect(() => {
  setFullName(`${firstName()} ${lastName()}`)
})
```

**Correct (cheap derivation — plain function):**

```typescript
const [firstName, setFirstName] = createSignal("John")
const [lastName, setLastName] = createSignal("Doe")

// GOOD: plain function — zero overhead, recalculates when called in tracked scope
const fullName = () => `${firstName()} ${lastName()}`
```

**Correct (expensive derivation — createMemo):**

```typescript
const [items, setItems] = createSignal<Item[]>([])
const [filter, setFilter] = createSignal("")

// GOOD: createMemo caches result, only recomputes when dependencies change
const filteredItems = createMemo(() =>
  items().filter(item => item.name.includes(filter()))
)
```

**When to use which:**

| Scenario | Use |
|----------|-----|
| Simple property access, string concat, math | Plain function `() => ...` |
| Filtering, sorting, mapping large arrays | `createMemo` |
| Side effects (fetch, DOM, logging) | `createEffect` |

**Notes:**
- Plain functions in SolidJS are naturally reactive when called inside JSX or effects — they re-evaluate when their signal dependencies change
- `createMemo` adds caching — use it when the computation is expensive or accessed in multiple places
- If you find yourself writing `createEffect(() => setX(...))`, it's almost always a sign you should use a derived function or memo instead

Reference: [SolidJS Derived Signals](https://docs.solidjs.com/concepts/derived-values/derived-signals)
