---
title: Use mergeProps for Default Values
impact: HIGH
impactDescription: "broken reactivity on defaulted props"
tags: props, mergeProps, defaults, reactivity
---

## Use mergeProps for Default Values

**Impact: HIGH (broken reactivity on defaulted props)**

When a component needs default values for optional props, use `mergeProps` instead of destructuring with defaults (`{ size = "md" }`). JavaScript destructuring defaults are evaluated once at component creation and lose reactivity.

**Incorrect (destructuring defaults lose reactivity):**

```typescript
// size defaults to "md" but won't update if parent changes the prop later
function Button({ size = "md", children }) {
  return <button class={`btn-${size}`}>{children}</button>
}
```

**Correct (mergeProps preserves reactivity):**

```typescript
import { mergeProps } from "solid-js"

function Button(props: { size?: "sm" | "md" | "lg" }) {
  const merged = mergeProps({ size: "md" as const }, props)

  // merged.size is reactive — updates when props.size changes
  return <button class={`btn-${merged.size}`}>{props.children}</button>
}
```

**Notes:**
- `mergeProps` creates a reactive proxy; later sources override earlier ones
- Combine with `splitProps` when you also need to forward remaining props
- For components with many defaults, `mergeProps` keeps the component body clean

Reference: [SolidJS mergeProps docs](https://docs.solidjs.com/reference/component-apis/merge-props)
