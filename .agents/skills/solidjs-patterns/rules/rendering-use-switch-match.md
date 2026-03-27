---
title: Use Switch/Match for Multi-Condition Rendering
impact: MEDIUM
impactDescription: "unreadable nested conditionals, potential remount bugs"
tags: Switch, Match, control flow, conditional rendering
---

## Use Switch/Match for Multi-Condition Rendering

**Impact: MEDIUM (unreadable nested conditionals, potential remount bugs)**

When rendering one of several mutually exclusive states (loading, error, success, empty), use `<Switch>/<Match>` instead of nested `<Show>` components or chained ternaries. `Switch/Match` is pattern-matching for JSX — only the first matching branch renders.

**Incorrect (nested Show components):**

```typescript
<Show when={!isLoading() && !error()}>
  <Show when={data()}>
    <DataView data={data()} />
  </Show>
  <Show when={!data()}>
    <EmptyState />
  </Show>
</Show>
<Show when={isLoading()}>
  <Loading />
</Show>
<Show when={error()}>
  <ErrorDisplay error={error()} />
</Show>
```

**Correct (Switch/Match for clear pattern matching):**

```typescript
import { Switch, Match } from "solid-js"

<Switch fallback={<EmptyState />}>
  <Match when={isLoading()}>
    <Loading />
  </Match>
  <Match when={error()}>
    <ErrorDisplay error={error()} />
  </Match>
  <Match when={data()}>
    {(resolvedData) => <DataView data={resolvedData()} />}
  </Match>
</Switch>
```

**Notes:**
- `Switch` evaluates `Match` children top-to-bottom and renders only the first truthy match
- The `fallback` prop on `Switch` acts as the default/else branch
- `Match` supports the same callback-children pattern as `Show` for type narrowing
- Use `Show` for simple boolean toggles; use `Switch/Match` when you have 3+ branches

Reference: [SolidJS Switch/Match docs](https://docs.solidjs.com/reference/components/switch-and-match)
