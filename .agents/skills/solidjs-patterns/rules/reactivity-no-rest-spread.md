---
title: Use splitProps Instead of Rest Spread
impact: CRITICAL
impactDescription: Extracted props lose reactivity silently
tags: reactivity, props, splitProps, destructuring, rest-spread
---

## Use splitProps Instead of Rest Spread

**Impact: CRITICAL (extracted props lose reactivity silently)**

Rest spread (`{ variant, ...rest }`) destructures, which captures values once. Use `splitProps` to maintain reactivity on all extracted props.

**Incorrect (rest spread loses reactivity on extracted props):**

```typescript
function Button({ variant, ...rest }: ButtonProps) {
  return (
    <button class={variant === "primary" ? "btn-primary" : "btn"} {...rest}>
      {rest.children}
    </button>
  )
}
// variant won't update if parent re-renders with new variant
```

**Correct (splitProps maintains reactivity):**

```typescript
import { splitProps } from "solid-js"

function Button(props: ButtonProps) {
  const [local, rest] = splitProps(props, ["variant"])
  return (
    <button class={local.variant === "primary" ? "btn-primary" : "btn"} {...rest}>
      {props.children}
    </button>
  )
}
// local.variant stays reactive
```

Reference: [SolidJS splitProps](https://docs.solidjs.com/reference/component-apis/split-props)
