---
title: Use untrack When Invoking Render Callbacks
impact: MEDIUM
impactDescription: "parent computations subscribe to signals inside child render functions"
tags: reactivity, untrack, children, render callbacks, ownership
---

## Use untrack When Invoking Render Callbacks

**Impact: MEDIUM (parent computations subscribe to signals inside child render functions)**

When a parent effect or memo calls a render callback (children-as-function, render props), wrap the call in `untrack()`. Without this, the parent computation subscribes to every signal the child accesses, causing the parent to re-run when child dependencies change.

**Incorrect (parent memo tracks child signals):**

```typescript
const Wrapper = (props) => {
  const output = createMemo(() => {
    const data = fetchData()
    // BAD: if props.children accesses its own signals, this memo
    // will re-run whenever those child signals change too
    return props.children(data)
  })

  return <div>{output()}</div>
}
```

**Correct (untrack prevents parent from subscribing to child signals):**

```typescript
const Wrapper = (props) => {
  const output = createMemo(() => {
    const data = fetchData()
    // GOOD: parent memo only tracks fetchData(), not child internals
    return untrack(() => props.children(data))
  })

  return <div>{output()}</div>
}
```

**This is how Solid's built-in components work internally:**

```typescript
// Simplified <Show> implementation from solid-js source:
return createMemo(() => {
  const c = condition()
  if (c) {
    // Children are called inside untrack to prevent Show
    // from subscribing to the child's dependencies
    return untrack(() => child(c))
  }
  return fallback
})
```

**Common scenarios where this matters:**

```typescript
// Render prop components
const DataProvider = (props) => {
  const data = createResource(/* ... */)

  return createMemo(() => {
    const d = data()
    return d ? untrack(() => props.render(d)) : props.fallback
  })
}

// Custom control flow
const When = (props) => {
  return createMemo(() => {
    return props.condition()
      ? untrack(() => props.children())
      : null
  })
}
```

**Notes:**
- `untrack` prevents the current computation from subscribing to signals read inside the callback — the child's own effects still track normally
- This is critical for control-flow components and any component that calls render callbacks inside `createMemo` or `createEffect`
- If you're building a component library, audit every place you call `props.children` inside a tracked scope
- SolidJS's `<Show>`, `<Switch>`, `<For>` all use this pattern internally

Reference: [SolidJS untrack](https://docs.solidjs.com/reference/reactive-utilities/untrack)
