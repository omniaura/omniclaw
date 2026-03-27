---
title: Use children() Helper to Resolve and Memoize Children
impact: MEDIUM
impactDescription: "repeated expensive child evaluation, inability to inspect/manipulate children"
tags: component, children, memoization, render props
---

## Use children() Helper to Resolve and Memoize Children

**Impact: MEDIUM (repeated expensive child evaluation, inability to inspect/manipulate children)**

When you need to inspect, iterate, or manipulate `props.children`, use the `children()` helper from `solid-js`. It resolves reactive children (functions, fragments) into resolved child values and memoizes the result. Resolved children can be DOM nodes, text nodes, primitives, JSX elements, or null.

**Incorrect (accessing props.children directly for manipulation):**

```typescript
const Wrapper = (props) => {
  // BAD: props.children might be a function, fragment, or reactive expression
  // Accessing it multiple times re-evaluates each time
  createEffect(() => {
    console.log(props.children) // Could be a getter, not resolved values
  })

  return <div>{props.children}</div>
}
```

**Correct (children() resolves and memoizes):**

```typescript
import { children, createEffect } from "solid-js"

const ColoredList = (props) => {
  const resolved = children(() => props.children)

  // resolved() returns resolved child values — safe to inspect/modify
  createEffect(() => {
    const nodes = resolved.toArray()
    nodes.forEach((node, i) => {
      if (node instanceof HTMLElement) {
        node.style.color = i % 2 === 0 ? "red" : "blue"
      }
    })
  })

  return <div>{resolved()}</div>
}
```

**When you need children() vs when you don't:**

```typescript
// DON'T need children() — just rendering children as-is
const Card = (props) => <div class="card">{props.children}</div>

// DO need children() — inspecting or transforming children
const Tabs = (props) => {
  const tabs = children(() => props.children)

  return (
    <div>
      <div class="tab-bar">
        <For each={tabs.toArray()}>
          {(tab) => <button>{(tab as HTMLElement).dataset.label}</button>}
        </For>
      </div>
      <div class="tab-content">{tabs()}</div>
    </div>
  )
}
```

**Notes:**
- `children()` returns a memo — call it as `resolved()` to get the resolved value
- Use `.toArray()` to get a flat array of all child nodes
- Only use `children()` when you need to inspect or manipulate — for simple pass-through, `props.children` is fine
- The helper handles all child types: static elements, dynamic expressions, arrays, and fragments

Reference: [SolidJS children helper](https://docs.solidjs.com/reference/component-apis/children)
