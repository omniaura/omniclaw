---
title: Use splitProps for Prop Forwarding
impact: HIGH
impactDescription: "broken reactivity on extracted props"
tags: props, splitProps, forwarding, reactivity
---

## Use splitProps for Prop Forwarding

**Impact: HIGH (broken reactivity on extracted props)**

When a component needs to separate its own props from native HTML props for forwarding, use `splitProps` instead of destructuring. Destructuring captures prop values once at component creation, so updates to the parent are silently lost.

**Incorrect (destructuring loses reactivity):**

```typescript
interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary"
  loading?: boolean
}

// variant and loading are read once — future updates ignored
function Button({ variant, loading, ...rest }: ButtonProps) {
  return (
    <button
      class={variant === "primary" ? "btn-primary" : "btn"}
      disabled={loading}
      {...rest}
    />
  )
}
```

**Correct (splitProps maintains reactivity):**

```typescript
import { splitProps, type JSX } from "solid-js"

function Button(props: ButtonProps) {
  const [local, buttonProps] = splitProps(props, ["variant", "loading"])

  return (
    <button
      {...buttonProps}
      class={local.variant === "primary" ? "btn-primary" : "btn"}
      disabled={local.loading || buttonProps.disabled}
    >
      {local.loading ? <Spinner /> : props.children}
    </button>
  )
}
```

**Notes:**
- `splitProps` returns proxied objects that preserve reactivity for all keys
- The first argument lists keys to extract into `local`; everything else goes into the rest group
- You can split into more than two groups: `splitProps(props, ["a"], ["b"])` returns three objects

Reference: [SolidJS splitProps docs](https://docs.solidjs.com/reference/component-apis/split-props)
