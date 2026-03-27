---
title: Don't Return Early Before Reactive Primitives
impact: HIGH
impactDescription: Hooks run inconsistently — effects and signals may not initialize
tags: component, early-return, hooks, show, lifecycle
---

## Don't Return Early Before Reactive Primitives

**Impact: HIGH (hooks run inconsistently — effects and signals may not initialize)**

SolidJS components run once. Early returns before `createSignal`/`createEffect` mean those primitives never execute. Unlike React, there's no "rules of hooks" error — it silently fails.

**Incorrect (early return before hooks):**

```typescript
function UserProfile(props) {
  if (!props.userId) {
    return <div>No user</div>
  }
  // These might never run
  const [data, setData] = createSignal(null)
  createEffect(() => { /* ... */ })
  return <div>{data()}</div>
}
```

**Correct (hooks always run, Show handles conditional rendering):**

```typescript
function UserProfile(props) {
  const [data, setData] = createSignal(null)

  createEffect(() => {
    if (props.userId) {
      fetchUser(props.userId).then(setData)
    }
  })

  return (
    <Show when={props.userId} fallback={<div>No user</div>}>
      <div>{data()}</div>
    </Show>
  )
}
```

Reference: [SolidJS Components](https://docs.solidjs.com/concepts/components/basics)
