---
title: Use Dynamic for Polymorphic Components
impact: MEDIUM
impactDescription: "verbose conditional JSX for component-switching, duplicated prop spreading"
tags: component, Dynamic, polymorphic, composition
---

## Use Dynamic for Polymorphic Components

**Impact: MEDIUM (verbose conditional JSX for component-switching, duplicated prop spreading)**

When a component needs to render as different elements or components based on a prop, use `<Dynamic>` instead of conditional branches. This is the standard pattern for "render as" / polymorphic component APIs.

**Incorrect (duplicated JSX branches):**

```typescript
const Button = (props) => {
  const [local, rest] = splitProps(props, ["as", "children"])

  // BAD: duplicate prop spreading, grows with each variant
  if (local.as === "a") return <a {...rest}>{local.children}</a>
  if (local.as === "link") return <A {...rest}>{local.children}</A>
  return <button {...rest}>{local.children}</button>
}
```

**Correct (Dynamic handles component switching):**

```typescript
import { Dynamic } from "solid-js/web"

const Button = (props) => {
  const [local, rest] = splitProps(props, ["as", "children", "class"])

  return (
    <Dynamic
      component={local.as ?? "button"}
      class={`btn ${local.class ?? ""}`}
      {...rest}
    >
      {local.children}
    </Dynamic>
  )
}

// Usage:
<Button>Click me</Button>              // renders <button>
<Button as="a" href="/about">Link</Button>  // renders <a>
<Button as={Link} to="/home">Route</Button> // renders <Link> component
```

**Common use cases:**

```typescript
// Heading level component
const Heading = (props) => {
  const [local, rest] = splitProps(props, ["level", "children"])
  return (
    <Dynamic component={`h${local.level ?? 1}`} {...rest}>
      {local.children}
    </Dynamic>
  )
}

// Icon component selecting by name
const Icon = (props) => {
  const icons = { home: HomeIcon, settings: SettingsIcon, user: UserIcon }
  return <Dynamic component={icons[props.name]} {...props} />
}
```

**Notes:**
- `component` accepts strings (`"div"`, `"a"`) or components (`MyComponent`)
- When `component` is reactive, `Dynamic` handles unmounting/remounting automatically
- Combine with `splitProps` to separate the `as`/`component` prop from pass-through props
- This is how component libraries (Hope UI, Kobalte) implement their polymorphic APIs

Reference: [SolidJS Dynamic](https://docs.solidjs.com/reference/components/dynamic)
