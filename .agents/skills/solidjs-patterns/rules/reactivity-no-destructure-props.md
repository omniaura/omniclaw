---
title: Never Destructure Props
impact: CRITICAL
impactDescription: Silent reactivity loss — UI stops updating
tags: reactivity, props, destructuring, migration
---

## Never Destructure Props

**Impact: CRITICAL (silent reactivity loss — UI stops updating)**

SolidJS components run once, not per-render. Destructuring props captures values at creation time — they never update.

**Incorrect (destructured props lose reactivity):**

```typescript
function Badge({ count, color }: BadgeProps) {
  return <span style={{ color }}>{count}</span>
}
// count and color are captured once — never update when parent passes new values
```

**Correct (access props directly or use splitProps/mergeProps):**

```typescript
function Badge(props: BadgeProps) {
  return <span style={{ color: props.color }}>{props.count}</span>
}

// With defaults:
function Badge(props: BadgeProps) {
  const merged = mergeProps({ color: "blue" }, props)
  return <span style={{ color: merged.color }}>{merged.count}</span>
}

// With prop separation:
function Badge(props: BadgeProps) {
  const [local, rest] = splitProps(props, ["variant"])
  return <span class={local.variant === "primary" ? "btn-primary" : "btn"} {...rest} />
}
```

Reference: [SolidJS Props Documentation](https://docs.solidjs.com/concepts/components/props)
