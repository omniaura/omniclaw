# SolidJS Anti-Patterns

These patterns look correct but break SolidJS reactivity. Avoid them.

## React Migration Gotchas

These patterns **technically work** but cause unexpected behavior. Critical for React-to-SolidJS migrations.

### Gotcha 1: Using .map() Instead of `<For>`

**Problem**: `.map()` works but if your list changes, every item remounts!

```typescript
// ❌ BAD: Creates new array on every update - ALL ChatMessages remount
{messages().map(message => (
  <ChatMessage key={message.id} data={message} />
)).reverse()}

// Symptoms: Avatar images flash/reload, scroll position jumps,
// console shows thousands of mounts for what should be incremental updates
```

**Solution**: Use `<For>` because it diffs your list - much better for lists that grow/shrink.

```typescript
// ✅ GOOD: <For> tracks items by reference, only new items mount
const reversedMessages = createMemo(() => [...messages()].reverse())

<For each={reversedMessages()}>
  {(message) => (
    <ChatMessage data={message} />
  )}
</For>
```

**Why it matters**: For chat history that grows via pagination, `.map()` caused 6000+ remounts instead of 10. Users saw avatars refreshing and scroll jumping.

### Gotcha 2: JSX Conditionals Instead of `<Show>`

**Problem**: JSX ternary/AND patterns work but cause unexpected remounts!

```typescript
// ❌ BAD: Component destroyed and recreated when condition changes
{isLoading() && <Spinner />}

{isLoggedIn() ? <Dashboard /> : <LoginForm />}

// Symptoms: Component state lost, animations restart,
// expensive effects re-run on every condition toggle
```

**Solution**: `<Show>` is tightly integrated with SolidJS signals and far more efficient.

```typescript
// ✅ GOOD: Component instances preserved, state maintained
<Show when={isLoading()}>
  <Spinner />
</Show>

<Show when={isLoggedIn()} fallback={<LoginForm />}>
  <Dashboard />
</Show>
```

**Why it matters**: `<Show>` preserves component instances when conditions remain true. JSX conditionals re-evaluate the entire branch on every reactive update.

---

## Anti-Pattern 1: Helper Functions for Store Access

**Problem**: Accessing store/signal inside a helper function breaks reactive tracking.

```typescript
// ❌ BAD: Access happens in helper, not in reactive JSX context
const [expanded, setExpanded] = createStore<boolean[]>([])

const isExpanded = (index: number) => expanded[index] === true

// In JSX - this WON'T update when expanded changes!
<Show when={isExpanded(index())}>
  <Content />
</Show>
```

**Solution**: Access store directly in JSX.

```typescript
// ✅ GOOD: Access happens directly in JSX reactive context
<Show when={expanded[index()]}>
  <Content />
</Show>
```

## Anti-Pattern 2: Using Set/Map with createSignal

**Problem**: Set and Map don't provide per-item reactivity with createSignal.

```typescript
// ❌ BAD: Changing any item causes ALL subscribers to update
const [expandedIds, setExpandedIds] = createSignal<Set<string>>(new Set())

const toggle = (id: string) => {
  setExpandedIds(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
}

// Every component using expandedIds() updates when ANY id changes
```

**Solution**: Use createStore with an array or record.

```typescript
// ✅ GOOD: Fine-grained reactivity per index/key
const [expanded, setExpanded] = createStore<boolean[]>([])

const toggle = (index: number) => {
  setExpanded(index, prev => !prev)
}

// Only components reading expanded[specificIndex] update
```

## Anti-Pattern 3: Destructuring Props

**Problem**: Destructuring props loses reactivity.

```typescript
// ❌ BAD: Props are accessed once at component creation
function Badge({ count, color }) {
  return <span style={{ color }}>{count}</span>
}

// count and color won't update when parent re-renders with new values
```

**Solution**: Access props directly or use mergeProps/splitProps.

```typescript
// ✅ GOOD: Props accessed reactively
function Badge(props) {
  return <span style={{ color: props.color }}>{props.count}</span>
}

// Or with defaults:
function Badge(props) {
  const merged = mergeProps({ color: "blue" }, props)
  return <span style={{ color: merged.color }}>{merged.count}</span>
}
```

## Anti-Pattern 4: Early Returns Before Hooks

**Problem**: Conditional returns before createSignal/createEffect break hook ordering.

```typescript
// ❌ BAD: Early return before hooks
function UserProfile(props) {
  if (!props.userId) {
    return <div>No user</div>
  }

  // These might not run consistently
  const [data, setData] = createSignal(null)
  createEffect(() => { /* ... */ })

  return <div>{data()}</div>
}
```

**Solution**: Use Show component for conditional rendering.

```typescript
// ✅ GOOD: Hooks always run, Show handles conditional rendering
function UserProfile(props) {
  const [data, setData] = createSignal(null)

  createEffect(() => {
    if (props.userId) {
      fetchUser(props.userId).then(setData)
    }
  })

  return (
    <Show when={props.userId} fallback={<div>No user</div>}>
      <div>{data()}</div>
    </Show>
  )
}
```

## Anti-Pattern 5: Array Index as Key in For

**Problem**: Using array index as key when items can be reordered/filtered.

```typescript
// ❌ BAD: Index-based keys cause incorrect updates when array changes
<For each={filteredItems()}>
  {(item, index) => (
    <Item key={index()} data={item} />
  )}
</For>
```

**Solution**: Use stable unique identifiers.

```typescript
// ✅ GOOD: Use item's unique ID
<For each={filteredItems()}>
  {(item) => (
    <Item key={item.id} data={item} />
  )}
</For>
```

Note: SolidJS's `<For>` is actually smart about this and tracks by reference by default, but explicit keys help with reordering.

## Anti-Pattern 6: Mutating Store Values Directly

**Problem**: Direct mutation doesn't trigger updates.

```typescript
// ❌ BAD: Direct mutation - no update triggered
const [state, setState] = createStore({ items: [] })

state.items.push(newItem) // Won't trigger reactivity!
```

**Solution**: Always use the setter function.

```typescript
// ✅ GOOD: Use setter for mutations
setState("items", items => [...items, newItem])

// Or use produce for complex mutations
import { produce } from "solid-js/store"

setState(produce(state => {
  state.items.push(newItem)
  state.count++
}))
```

## Anti-Pattern 7: Accessing Signals in Event Handler Setup

**Problem**: Signals accessed during event handler definition, not execution.

```typescript
// ❌ BAD: multiplier() is evaluated once when effect runs
createEffect(() => {
  element.addEventListener("click", () => {
    // multiplier() was captured when effect ran, not when clicked
    setCount(c => c * multiplier())
  })
})
```

**Solution**: Access signals inside the handler.

```typescript
// ✅ GOOD: Access signal when handler executes
<button onClick={() => setCount(c => c * multiplier())}>
  Multiply
</button>
```

## Anti-Pattern 8: Forgetting onCleanup in Effects

**Problem**: Memory leaks from subscriptions/listeners not cleaned up.

```typescript
// ❌ BAD: Listener never removed
createEffect(() => {
  window.addEventListener("resize", handleResize)
})
```

**Solution**: Always clean up side effects.

```typescript
// ✅ GOOD: Cleanup on effect re-run or component unmount
createEffect(() => {
  window.addEventListener("resize", handleResize)
  onCleanup(() => window.removeEventListener("resize", handleResize))
})
```

## Anti-Pattern 9: Using Rest Spread Instead of splitProps

**Problem**: Rest spread with destructuring loses reactivity on extracted props.

```typescript
// ❌ BAD: variant won't update if props change
function Button({ variant, ...rest }: ButtonProps) {
  return (
    <button class={variant === "primary" ? "btn-primary" : "btn"} {...rest}>
      {rest.children}
    </button>
  )
}
```

**Solution**: Use `splitProps` to maintain reactivity.

```typescript
// ✅ GOOD: local.variant stays reactive
import { splitProps } from "solid-js"

function Button(props: ButtonProps) {
  const [local, rest] = splitProps(props, ["variant"])
  return (
    <button class={local.variant === "primary" ? "btn-primary" : "btn"} {...rest}>
      {props.children}
    </button>
  )
}
```

## Anti-Pattern 10: Suspense Wrapping Conditionals

**Problem**: Suspense around Show/Switch causes layout flicker when condition changes.

```typescript
// ❌ BAD: Suspense boundary causes flicker on modal open/close
<Suspense fallback={<Loading />}>
  <Show when={isModalOpen()}>
    <HeavyModal />
  </Show>
</Suspense>
```

**Solution**: Use LazyShow pattern - Suspense inside the conditional.

```typescript
// ✅ GOOD: LazyShow puts Suspense inside the Show
import { LazyShow } from "@/components/ui/LazyShow"

<LazyShow when={isModalOpen()} fallback={<Loading />}>
  {() => <HeavyModal />}
</LazyShow>
```

See [Performance Patterns](performance.md) for the full LazyShow implementation.

## Anti-Pattern 11: Plain Refs for Timing-Sensitive State

**Problem**: Plain JS variables/refs get captured in closures at scheduling time, not execution time.

```typescript
// ❌ BAD: Ref value captured when setTimeout is scheduled
let isPaginating = false

const handleLoadMore = () => {
  isPaginating = true  // Set the flag
  fetchNextPage()      // Async - returns immediately
}

createEffect(() => {
  // This setTimeout captures isPaginating at scheduling time
  const timeout = setTimeout(() => {
    if (!isPaginating) {  // ❌ Reads OLD value from closure
      scrollToBottom()     // Scroll happens even though isPaginating was set!
    }
  }, 100)
  return () => clearTimeout(timeout)
})
```

**Why this fails**: When `setTimeout` callback is created, it captures `isPaginating` by reference at that moment. Even if `isPaginating` changes before the callback runs, the callback reads the stale captured value.

**Solution**: Use signals for state that must be read at execution time.

```typescript
// ✅ GOOD: Signal is read at execution time, not captured
const [isPaginating, setIsPaginating] = createSignal(false)

const handleLoadMore = () => {
  setIsPaginating(true)
  fetchNextPage()
}

createEffect(() => {
  const timeout = setTimeout(() => {
    if (!isPaginating()) {  // ✅ Reads CURRENT value
      scrollToBottom()
    }
  }, 100)
  return () => clearTimeout(timeout)
})
```

### Real-World Example: Pagination Scroll Blocking

When loading older messages, we need to prevent scroll-to-bottom during the async gap:

```typescript
// Problem: React Query's isFetchingNextPage updates AFTER fetchNextPage() returns
// Solution: Set a blocking signal SYNCHRONOUSLY before the async call

const [isPaginatingNow, setIsPaginatingNow] = createSignal(false)

const handleLoadMore = () => {
  // Set IMMEDIATELY, BEFORE async fetchNextPage
  setIsPaginatingNow(true)
  fetchNextPage()  // Async - isFetchingNextPage updates later
}

// Clear after pagination completes
createEffect(() => {
  if (!isFetchingNextPage && isPaginatingNow()) {
    setTimeout(() => setIsPaginatingNow(false), 500)
  }
})

// Effects read the signal at execution time
createEffect(() => {
  if (isPaginatingNow()) {
    return  // Block scroll-to-bottom
  }
  scrollToBottom()
})
```

**Key insight**: Signals are **read** when called. Refs are **captured** when closures are created.

## Anti-Pattern 12: Assuming Effect Order

**Problem**: Effects run in dependency order, not definition order.

```typescript
// ❌ BAD: Assuming first effect runs before second
createEffect(() => {
  // "I'll set the flag here first"
  wasPaginatingRef.current = props.isFetchingNextPage
})

createEffect(() => {
  // "Then this will see the flag"
  if (!wasPaginatingRef.current) {
    scrollToBottom()  // ❌ May run BEFORE the first effect!
  }
})
```

**Why this fails**: SolidJS effects run when their dependencies change, not in source code order. The second effect might run before the first if their dependencies update in different orders.

**Solution**: Use a single signal that both effects can read reliably.

```typescript
// ✅ GOOD: Shared signal state, read at execution time
const [isBlocked, setIsBlocked] = createSignal(false)

// One effect manages the signal
createEffect(() => {
  setIsBlocked(props.isFetchingNextPage)
})

// Other effects read it
createEffect(() => {
  if (isBlocked()) return
  scrollToBottom()
})
```

Or better - avoid the two-effect pattern entirely by combining logic:

```typescript
// ✅ BEST: Single effect with all logic
createEffect(() => {
  if (props.isFetchingNextPage) return
  scrollToBottom()
})
```
