# SolidJS Reactivity Fundamentals

Understanding how SolidJS reactivity works is crucial for writing correct code.

## Signals: The Basic Reactive Primitive

```typescript
import { createSignal } from "solid-js"

const [count, setCount] = createSignal(0)

// Reading: call the getter
console.log(count()) // 0

// Writing: call the setter
setCount(1)
setCount(prev => prev + 1)
```

### When Signals Track

Signals only track access **inside reactive contexts**:

```typescript
// ✅ Reactive context - will update when count changes
<div>{count()}</div>

// ✅ Reactive context - createEffect
createEffect(() => {
  console.log(count()) // Re-runs when count changes
})

// ✅ Reactive context - createMemo
const doubled = createMemo(() => count() * 2)

// ❌ NOT reactive - plain function call
function getCount() {
  return count() // Access happens here, outside JSX
}
<div>{getCount()}</div> // Won't update!
```

## Stores: Fine-Grained Nested Reactivity

Stores provide **per-property reactivity** for objects and arrays:

```typescript
import { createStore } from "solid-js/store"

const [state, setState] = createStore({
  users: [],
  settings: { theme: "dark" }
})

// Reading: access like a normal object (no function call)
console.log(state.settings.theme) // "dark"

// Writing: path-based setters
setState("settings", "theme", "light")
setState("users", users => [...users, newUser])
```

### Store vs Signal for Collections

```typescript
// ❌ BAD: Signal with array - changing one item updates ALL subscribers
const [items, setItems] = createSignal<Item[]>([])
setItems(prev => prev.map((item, i) => i === 2 ? newItem : item))

// ✅ GOOD: Store with array - changing items[2] only updates that subscriber
const [items, setItems] = createStore<Item[]>([])
setItems(2, newItem)
```

## Reactive Contexts

Code runs in a reactive context when inside:

1. **JSX expressions**: `<div>{signal()}</div>`
2. **createEffect**: `createEffect(() => { ... })`
3. **createMemo**: `createMemo(() => { ... })`
4. **createRenderEffect**: `createRenderEffect(() => { ... })`
5. **Component function body** (first run only)

Code does NOT run in reactive context when:

1. Inside event handlers: `onClick={() => { ... }}`
2. Inside setTimeout/setInterval callbacks
3. Inside Promise callbacks
4. Inside helper functions called from JSX

## The Tracking Scope Rule

**Signal/store access must happen IN the reactive context, not before it:**

```typescript
// ❌ Access happens in helper, not in JSX reactive context
const isActive = (id: string) => activeItems()[id]
<Show when={isActive(item.id)}>...</Show>

// ✅ Access happens directly in JSX reactive context
<Show when={activeItems()[item.id]}>...</Show>
```

## Memos for Derived State

Use `createMemo` when you have expensive computations that depend on signals:

```typescript
const [items, setItems] = createSignal<Item[]>([])

// ✅ Computed once, cached until items changes
const totalPrice = createMemo(() =>
  items().reduce((sum, item) => sum + item.price, 0)
)

// Use like a signal
<div>Total: ${totalPrice()}</div>
```

## Effects for Side Effects

Use `createEffect` for side effects that should run when dependencies change:

```typescript
createEffect(() => {
  // Runs whenever user() changes
  const currentUser = user()
  if (currentUser) {
    analytics.identify(currentUser.id)
  }
})
```

### Effect Cleanup

```typescript
createEffect(() => {
  const handler = () => console.log("resize")
  window.addEventListener("resize", handler)

  onCleanup(() => {
    window.removeEventListener("resize", handler)
  })
})
```
