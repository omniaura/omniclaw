---
title: Use useTransition for Non-Blocking Async Updates
impact: MEDIUM
impactDescription: "UI freezes during async state transitions"
tags: useTransition, async, Suspense, pending state
---

## Use useTransition for Non-Blocking Async Updates

**Impact: MEDIUM (UI freezes during async state transitions)**

When switching between views that trigger Suspense boundaries (tab switches, route transitions), wrap the state update in `startTransition` from `useTransition`. This keeps the current view visible with a pending indicator while the new view loads, instead of flashing a loading fallback.

**Incorrect (direct state update triggers immediate Suspense fallback):**

```typescript
const [tab, setTab] = createSignal("home")

// Clicking a tab instantly shows the Suspense fallback spinner,
// hiding the current content while the new tab loads
const switchTab = (newTab: string) => {
  setTab(newTab)
}

<Suspense fallback={<Loading />}>
  <TabContent tab={tab()} />  {/* Content disappears during load */}
</Suspense>
```

**Correct (useTransition keeps current content visible):**

```typescript
import { useTransition, createSignal, Suspense } from "solid-js"

function TabSwitcher() {
  const [isPending, startTransition] = useTransition()
  const [tab, setTab] = createSignal("home")

  const switchTab = (newTab: string) => {
    startTransition(() => setTab(newTab))
  }

  return (
    <>
      <TabButtons
        onSelect={switchTab}
        pending={isPending()}
      />
      <Suspense fallback={<Loading />}>
        <div style={{ opacity: isPending() ? 0.6 : 1 }}>
          <TabContent tab={tab()} />
        </div>
      </Suspense>
    </>
  )
}
```

**Notes:**
- `startTransition` delays the state update until the new Suspense boundary resolves
- `isPending()` is a reactive signal that is `true` while the transition is in progress — use it for subtle loading indicators (opacity, spinners on tabs)
- This pattern is especially valuable for route transitions where the Suspense fallback would otherwise flash
- Only wrap updates that trigger Suspense; non-async updates gain nothing from transitions

Reference: [SolidJS useTransition docs](https://docs.solidjs.com/reference/reactive-utilities/use-transition)
