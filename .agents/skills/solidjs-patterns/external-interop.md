# External Interop: `from` and `observable`

SolidJS provides two utilities for bridging between its reactive system and external subscription-based APIs:

- **`from`** - Converts external subscriptions INTO Solid signals
- **`observable`** - Converts Solid signals OUT TO observables

## `from` - External Sources → Solid Signals

Use `from` when you have an external subscription-based API and want to consume it as a reactive Solid signal.

### Signature

```typescript
import { from } from "solid-js"

function from<T>(
  producer: ((set: (v: T) => T) => () => void) | { subscribe: Function }
): Accessor<T | undefined>
```

### When to Use `from`

| Use Case | Example |
|----------|---------|
| Browser APIs with event listeners | `matchMedia`, `ResizeObserver`, `IntersectionObserver` |
| RxJS observables | `from(myObservable$)` |
| Svelte stores | `from(svelteStore)` |
| Custom subscription patterns | Websockets, EventEmitters |
| Any "subscribe/unsubscribe" pattern | Third-party state managers |

### Real Example: `useMediaQuery` Hook

Our codebase uses `from` to create a reactive media query hook:

```typescript
// src/hooks/useMediaQuery.tsx
import { Accessor, from } from "solid-js"

export function useMediaQuery(query: string): Accessor<boolean | undefined> {
  return from((set) => {
    if (typeof window === "undefined") {
      set(false)
      return () => {}  // Must always return cleanup function
    }

    const media = window.matchMedia(query)
    set(media.matches)  // Set initial value

    const listener = () => set(media.matches)
    media.addEventListener("change", listener)

    return () => media.removeEventListener("change", listener)  // Cleanup
  })
}
```

**Usage:**
```typescript
const isWidescreen = useMediaQuery("(min-width: 1280px)")
const prefersDark = useMediaQuery("(prefers-color-scheme: dark)")

// In JSX or effects - reactive!
createEffect(() => {
  if (isWidescreen()) {
    // This re-runs when screen size crosses 1280px
  }
})
```

### Producer Function Pattern

The producer function receives a `set` callback and must return a cleanup function:

```typescript
const signal = from((set) => {
  // 1. Set initial value (optional)
  set(initialValue)

  // 2. Subscribe to changes
  const unsubscribe = someAPI.subscribe((newValue) => {
    set(newValue)
  })

  // 3. MUST return cleanup function (even if empty)
  return () => unsubscribe()
})
```

### Common Patterns

**Interval/Timer:**
```typescript
const elapsed = from((set) => {
  let count = 0
  set(count)
  const id = setInterval(() => set(++count), 1000)
  return () => clearInterval(id)
})
```

**ResizeObserver:**
```typescript
function useElementSize(element: () => HTMLElement | null) {
  return from((set) => {
    const el = element()
    if (!el) {
      set({ width: 0, height: 0 })
      return () => {}
    }

    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect
      set({ width, height })
    })

    observer.observe(el)
    return () => observer.disconnect()
  })
}
```

**WebSocket:**
```typescript
function useWebSocket(url: string) {
  return from((set) => {
    const ws = new WebSocket(url)
    ws.onmessage = (e) => set(JSON.parse(e.data))
    return () => ws.close()
  })
}
```

### Key Rules for `from`

1. **Always return a cleanup function** - Even if empty (`return () => {}`), Solid requires it
2. **Return type is `T | undefined`** - The signal starts as `undefined` until first `set()` call
3. **Automatic cleanup** - Solid calls the cleanup when the reactive scope is disposed
4. **SSR safety** - Check `typeof window` for browser-only APIs

## `observable` - Solid Signals → External Observables

Use `observable` when you need to expose a Solid signal to an external library that expects an Observable (like RxJS).

### Signature

```typescript
import { observable } from "solid-js"

function observable<T>(input: Accessor<T>): Observable<T>
```

### When to Use `observable`

| Use Case | Example |
|----------|---------|
| RxJS integration | Piping through RxJS operators |
| External libraries expecting observables | Analytics, logging pipelines |
| Interop with other reactive systems | Connecting to non-Solid code |

### Example with RxJS

```typescript
import { observable } from "solid-js"
import { from as rxFrom, debounceTime, distinctUntilChanged } from "rxjs"

const [searchTerm, setSearchTerm] = createSignal("")

// Convert Solid signal to RxJS observable
const search$ = rxFrom(observable(searchTerm))

// Use RxJS operators
search$.pipe(
  debounceTime(300),
  distinctUntilChanged()
).subscribe((term) => {
  performSearch(term)
})
```

## Comparison: `from` vs `observable`

| Aspect | `from` | `observable` |
|--------|--------|--------------|
| Direction | External → Solid | Solid → External |
| Input | Producer function or subscribable | Solid accessor |
| Output | Solid accessor | Observable |
| Use case | Consume external data reactively | Expose signals to RxJS/etc |

## When NOT to Use These

- **Don't use `from` for simple one-time values** - Just use `createSignal`
- **Don't use `from` if you have control over the source** - Build with signals from the start
- **Don't use `observable` for Solid-to-Solid communication** - Use signals directly
- **Don't use either for props/context** - Use Solid's built-in patterns

## Anti-Pattern: Non-Reactive matchMedia

```typescript
// BAD: One-shot check, won't react to window resize
createEffect(() => {
  const isSmall = window.matchMedia("(max-width: 768px)").matches
  if (isSmall) doSomething()
})

// GOOD: Reactive, updates when screen size changes
const isSmall = useMediaQuery("(max-width: 768px)")
createEffect(() => {
  if (isSmall()) doSomething()
})
```

## Related

- [Reactivity Fundamentals](reactivity.md) - Understanding signals and effects
- [State Management Patterns](state-patterns.md) - Choosing the right primitive
- [Advanced Primitives](advanced-primitives.md) - Other secondary primitives
