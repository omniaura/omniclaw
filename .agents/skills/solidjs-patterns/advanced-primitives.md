# SolidJS Advanced Primitives

Beyond the core `createSignal`, `createStore`, `createEffect`, and `createMemo`, SolidJS provides secondary primitives for specialized use cases.

## Effect Variants

### createRenderEffect

Runs **during** the render phase, before DOM is committed. Use for immediate DOM measurements or synchronous updates.

```typescript
import { createRenderEffect } from "solid-js"

createRenderEffect(() => {
  // Runs synchronously during render
  // Use for DOM measurements that must happen before paint
  const height = containerRef.offsetHeight
  updateLayout(height)
})
```

**When to use**: DOM measurements, layout synchronization, immediate style updates.

**Caution**: Avoid heavy computation here - it blocks rendering.

### createComputed

Runs **before** render, synchronously when dependencies change. Creates derived state that's always in sync.

```typescript
import { createComputed } from "solid-js"

const [firstName, setFirstName] = createSignal("John")
const [lastName, setLastName] = createSignal("Doe")

let fullName = ""
createComputed(() => {
  fullName = `${firstName()} ${lastName()}`
})
// fullName is immediately updated when either signal changes
```

**When to use**: Synchronous derived state that must be available immediately (not lazily computed like `createMemo`).

**Note**: Unlike `createMemo`, the value is assigned to an external variable, not returned.

### createReaction

Separates **tracking** from **side effects**. First function tracks dependencies, second runs when they change.

```typescript
import { createReaction } from "solid-js"

const track = createReaction(() => {
  // This runs when tracked dependencies change
  console.log("User changed:", user())
})

// Start tracking
track(() => user().id) // Only tracks user().id, not other user properties
```

**When to use**: Fine-grained control over what triggers effects, avoiding unwanted re-runs.

### createDeferred

Creates a signal that only updates when the browser is idle. Prevents UI jank during rapid updates.

```typescript
import { createDeferred } from "solid-js"

const [searchTerm, setSearchTerm] = createSignal("")
const deferredSearch = createDeferred(searchTerm, { timeoutMs: 250 })

// deferredSearch() updates after browser is idle or timeout
<ExpensiveSearchResults query={deferredSearch()} />
```

**When to use**: Expensive computations triggered by rapid user input (search, filtering).

## Selection Optimization

### createSelector

Optimizes list selection by only updating affected items when selection changes.

```typescript
import { createSelector, For } from "solid-js"

function SelectableList() {
  const [selectedId, setSelectedId] = createSignal<string | null>(null)

  // Creates an optimized selector function
  const isSelected = createSelector(selectedId)

  return (
    <For each={items()}>
      {(item) => (
        <div
          // Only this specific item re-runs when it becomes selected/deselected
          classList={{ selected: isSelected(item.id) }}
          onClick={() => setSelectedId(item.id)}
        >
          {item.name}
        </div>
      )}
    </For>
  )
}
```

**When to use**: Large lists with single-selection where you want O(1) updates instead of O(n).

**How it works**: Instead of every item checking `selectedId() === item.id` (all re-run on change), only the previously-selected and newly-selected items update.

## Async Patterns

### useTransition

Batches state updates and shows pending state during async operations.

```typescript
import { useTransition } from "solid-js"

function TabSwitcher() {
  const [isPending, startTransition] = useTransition()
  const [tab, setTab] = createSignal("home")

  const switchTab = (newTab: string) => {
    startTransition(() => setTab(newTab))
  }

  return (
    <>
      <TabButtons onSelect={switchTab} pending={isPending()} />
      <Suspense fallback={<Loading />}>
        <TabContent tab={tab()} />
      </Suspense>
    </>
  )
}
```

**When to use**: Tab switches, route transitions, or any async boundary where you want to show pending state.

## Array Utilities

### indexArray

For arrays where items are fixed but indices change (filtering, sorting).

```typescript
import { indexArray } from "solid-js"

const [items, setItems] = createSignal([1, 2, 3])

// Items are keyed by index - efficient when indices change frequently
const doubled = indexArray(items, (item, index) => item() * 2)
```

### mapArray

For arrays where items change but indices are stable.

```typescript
import { mapArray } from "solid-js"

const [users, setUsers] = createSignal<User[]>([])

// Items are keyed by reference - efficient when items are added/removed
const userCards = mapArray(users, (user, index) => (
  <UserCard user={user} position={index()} />
))
```

**Rule of thumb**:
- `mapArray` (default `<For>` behavior): Items stable, indices change
- `indexArray`: Indices stable, item values change

## Lifecycle

### onMount

Runs once after component is mounted to DOM.

```typescript
import { onMount } from "solid-js"

function Component() {
  let inputRef: HTMLInputElement

  onMount(() => {
    inputRef.focus()
    // DOM is guaranteed to exist here
  })

  return <input ref={inputRef!} />
}
```

### onCleanup

Runs when effect re-runs or component unmounts. Essential for preventing memory leaks.

```typescript
import { createEffect, onCleanup } from "solid-js"

createEffect(() => {
  const handler = (e: KeyboardEvent) => {
    if (e.key === "Escape") close()
  }

  window.addEventListener("keydown", handler)

  onCleanup(() => {
    window.removeEventListener("keydown", handler)
  })
})
```

**Critical**: Always clean up subscriptions, event listeners, timers, and WebSocket connections.

## Control Flow Components

### Switch/Match

Pattern matching for conditional rendering (more readable than nested `Show`).

```typescript
import { Switch, Match } from "solid-js"

<Switch fallback={<DefaultView />}>
  <Match when={status() === "loading"}>
    <Loading />
  </Match>
  <Match when={status() === "error"}>
    <Error message={error()} />
  </Match>
  <Match when={status() === "success"}>
    <Success data={data()} />
  </Match>
</Switch>
```

### ErrorBoundary

Catches errors in child components.

```typescript
import { ErrorBoundary } from "solid-js"

<ErrorBoundary fallback={(err, reset) => (
  <div>
    <p>Something went wrong: {err.message}</p>
    <button onClick={reset}>Try Again</button>
  </div>
)}>
  <RiskyComponent />
</ErrorBoundary>
```

## Prop Utilities

### mergeProps

Combines props with defaults, maintaining reactivity.

```typescript
import { mergeProps } from "solid-js"

function Button(props: { size?: "sm" | "md" | "lg" }) {
  const merged = mergeProps({ size: "md" }, props)
  // merged.size is reactive and defaults to "md"
  return <button class={`btn-${merged.size}`} />
}
```

### splitProps

Separates props into groups for forwarding.

```typescript
import { splitProps } from "solid-js"

function Input(props: InputProps & JSX.InputHTMLAttributes<HTMLInputElement>) {
  const [local, inputProps] = splitProps(props, ["label", "error"])

  return (
    <div>
      <label>{local.label}</label>
      <input {...inputProps} />
      <Show when={local.error}>
        <span class="error">{local.error}</span>
      </Show>
    </div>
  )
}
```

**Why not destructure?** Destructuring breaks reactivity - props are read once at component creation. `splitProps` maintains reactivity for all extracted props.
