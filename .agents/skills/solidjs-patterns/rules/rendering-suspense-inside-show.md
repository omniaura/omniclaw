---
title: Place Suspense Inside Conditionals (LazyShow Pattern)
impact: MEDIUM-HIGH
impactDescription: Layout flicker when toggling modals/conditional content
tags: rendering, suspense, show, lazy, modal, flicker
---

## Place Suspense Inside Conditionals (LazyShow Pattern)

**Impact: MEDIUM-HIGH (layout flicker when toggling modals/conditional content)**

Wrapping `<Show>` inside `<Suspense>` causes the Suspense fallback to flash every time the condition changes. Placing Suspense inside the Show (LazyShow pattern) avoids this.

**Incorrect (Suspense around Show — flicker on toggle):**

```typescript
<Suspense fallback={<Loading />}>
  <Show when={isModalOpen()}>
    <HeavyModal />
  </Show>
</Suspense>
```

**Correct (LazyShow pattern — Suspense inside Show):**

```typescript
function LazyShow<T>(props: {
  when: T | undefined | null | false
  fallback?: JSX.Element
  children: (value: NonNullable<T>) => JSX.Element
}) {
  return (
    <Show when={props.when}>
      {(value) => (
        <Suspense fallback={props.fallback}>
          {props.children(value())}
        </Suspense>
      )}
    </Show>
  )
}

// Usage
<LazyShow when={isModalOpen()}>
  {() => <HeavyModal />}
</LazyShow>
```

Reference: [SolidJS Suspense](https://docs.solidjs.com/reference/components/suspense)
