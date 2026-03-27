# Explicit Dependency Tracking with `on()` and `untrack()`

SolidJS auto-tracks all signals read inside effects by default. Two utilities give you explicit control over tracking:

- **`on()`** - Wrap an entire effect to specify exact dependencies (like React's useEffect deps)
- **`untrack()`** - Read a signal without creating a dependency (surgical opt-out)

## When to Use `on()`

Use `on()` when you need to:

1. **Prevent unwanted re-runs** - Read signals in an effect without tracking them
2. **Break circular dependencies** - Effect modifies a signal it also reads
3. **Control timing precisely** - Only react to specific signal changes
4. **Access previous values** - Get the previous value of a signal

## Basic Syntax

```typescript
import { createEffect, on } from "solid-js"

// Auto-tracking (default behavior)
createEffect(() => {
  console.log(signalA(), signalB()) // Tracks BOTH signals
})

// Explicit tracking with on()
createEffect(on(
  () => signalA(),           // Only track this
  (a) => {
    console.log(a, signalB()) // signalB is NOT tracked
  }
))
```

## Key Behavior: Callback Body is Untracked

The callback passed to `on()` runs in an **untracked context**. Any signals read inside will NOT create dependencies:

```typescript
createEffect(on(
  () => trigger(),
  (value) => {
    // These reads do NOT cause the effect to re-run:
    console.log(otherSignal())
    console.log(store.someProperty)

    // Only changes to trigger() will re-run this effect
  }
))
```

This is equivalent to:

```typescript
createEffect(() => {
  const value = trigger() // tracked
  untrack(() => {
    console.log(otherSignal()) // untracked
    console.log(store.someProperty) // untracked
  })
})
```

## Multiple Dependencies

Pass an array of accessors to track multiple signals:

```typescript
createEffect(on(
  [() => signalA(), () => signalB()],
  ([a, b], [prevA, prevB]) => {
    console.log("Current:", a, b)
    console.log("Previous:", prevA, prevB)
  }
))
```

Or return a tuple from a single accessor:

```typescript
createEffect(on(
  () => [signalA(), signalB()] as const,
  ([a, b]) => {
    // Runs when either changes
  }
))
```

## Options

### `defer: true` - Skip Initial Run

By default, effects run immediately. Use `defer: true` to skip the first run:

```typescript
createEffect(on(
  () => searchTerm(),
  (term) => {
    // Won't run on mount, only on subsequent changes
    fetchResults(term)
  },
  { defer: true }
))
```

## Real-World Example: Breaking Circular Dependencies

This was the exact bug fixed in `SendMessage.tsx`. The effect was tracking both query data AND `isWaitingForResponse`, creating a feedback loop:

```typescript
// ❌ BUG: Circular dependency
createEffect(() => {
  const status = streamStatusQuery.data
  if (!status) return

  // Reading isWaitingForResponse() creates a dependency!
  if (status.isStreaming && !isWaitingForResponse()) {
    setIsWaitingForResponse(true)
  } else if (!status.isStreaming && isWaitingForResponse()) {
    setIsWaitingForResponse(false) // This triggers the effect again!
  }
})

// ✅ FIX: Only track query data changes
createEffect(on(
  () => streamStatusQuery.data,
  (status) => {
    if (!status) return

    // Reading isWaitingForResponse() here is UNTRACKED
    // Effect only re-runs when query data changes
    if (status.isStreaming && !isWaitingForResponse()) {
      setIsWaitingForResponse(true)
    }
  },
  { defer: true }
))
```

## Common Patterns

### Pattern 1: Sync External State Without Feedback Loop

```typescript
// Sync local state FROM external source, but not vice versa
createEffect(on(
  () => externalQuery.data,
  (data) => {
    if (data && !localState()) {
      setLocalState(data.value)
    }
  }
))
```

### Pattern 2: Debounced Effect

```typescript
// Only track the input, not the debounce timer state
createEffect(on(
  () => searchInput(),
  (input) => {
    const timer = setTimeout(() => {
      performSearch(input)
    }, 300)
    onCleanup(() => clearTimeout(timer))
  }
))
```

### Pattern 3: Access Previous Value

```typescript
createEffect(on(
  () => currentPage(),
  (current, previous) => {
    if (previous !== undefined) {
      analytics.track("page_change", { from: previous, to: current })
    }
  }
))
```

### Pattern 4: Conditional Side Effect

```typescript
// Only run when isEnabled changes, read other state without tracking
createEffect(on(
  () => isEnabled(),
  (enabled) => {
    if (enabled) {
      const config = untrack(() => settings()) // Extra clarity, though unnecessary inside on()
      initializeFeature(config)
    }
  }
))
```

---

## `untrack()` - Surgical Dependency Opt-Out

While `on()` restructures the entire effect, `untrack()` lets you opt out of tracking for specific reads within a normal effect.

```typescript
import { createEffect, untrack } from "solid-js"

createEffect(() => {
  const a = signalA()              // tracked - effect re-runs when A changes
  const b = untrack(() => signalB()) // NOT tracked - B changes won't trigger
  console.log(a, b)
})
```

### When to Use `untrack()` vs `on()`

| Scenario | Use |
|----------|-----|
| Most reads should NOT track | `on()` |
| Most reads SHOULD track, one exception | `untrack()` |
| Need previous values | `on()` |
| Need `defer: true` | `on()` |
| Quick one-off read without tracking | `untrack()` |

### `untrack()` Use Cases

#### 1. Read Initial Value Only

```typescript
createEffect(() => {
  // Only track future changes to items, not config
  const config = untrack(() => userConfig())

  // This triggers re-runs
  const items = filteredItems()

  applyConfig(config, items)
})
```

#### 2. Conditional Tracking

```typescript
createEffect(() => {
  const isEnabled = featureFlag() // tracked

  if (isEnabled) {
    // Only read settings when feature is enabled, but don't re-run when settings change
    const settings = untrack(() => advancedSettings())
    initFeature(settings)
  }
})
```

#### 3. Logging/Debugging Without Side Effects

```typescript
createEffect(() => {
  const value = importantSignal() // tracked

  // Log other state without creating dependencies
  console.log("Debug context:", untrack(() => ({
    user: currentUser(),
    session: sessionId(),
    timestamp: Date.now()
  })))

  processValue(value)
})
```

#### 4. Inside Event Handlers (Usually Unnecessary)

Event handlers are already untracked, but `untrack()` can add clarity:

```typescript
// These are equivalent - event handlers don't track
<button onClick={() => doSomething(count())}>Click</button>
<button onClick={() => doSomething(untrack(() => count()))}>Click</button>
```

### `untrack()` Returns the Value

`untrack()` returns whatever the callback returns:

```typescript
const value = untrack(() => mySignal()) // value is the signal's current value
const result = untrack(() => expensiveComputation(a(), b())) // result is the computation
```

### Nested Tracking Contexts

`untrack()` only affects the immediate callback - nested reactive contexts restore tracking:

```typescript
createEffect(() => {
  untrack(() => {
    console.log(signalA()) // NOT tracked

    // But if you create a new effect inside...
    createEffect(() => {
      console.log(signalB()) // IS tracked (new reactive context)
    })
  })
})
```

---

## Comparison: Auto-Tracking vs `on()` vs `untrack()`

| Aspect | Auto-Tracking | `on()` | `untrack()` |
|--------|---------------|--------|-------------|
| Dependency detection | Automatic | Explicit list | Explicit opt-out |
| Mental model | SolidJS native | React-like | Surgical |
| Scope | Entire effect | Entire effect | Single read |
| Previous values | No | Yes | No |
| Defer option | No | Yes | No |
| Best for | Simple effects | Full control | One-off exceptions |

## When NOT to Use `on()`

Don't use `on()` when:

1. **Simple effects** - Auto-tracking is simpler and less error-prone
2. **All dependencies should trigger** - If you want the effect to run when ANY read signal changes
3. **You're unsure** - Default to auto-tracking, refactor to `on()` only when needed

```typescript
// ✅ Simple case - auto-tracking is fine
createEffect(() => {
  document.title = `${count()} items`
})

// ❌ Overkill - on() adds complexity without benefit
createEffect(on(
  () => count(),
  (c) => {
    document.title = `${c} items`
  }
))
```
