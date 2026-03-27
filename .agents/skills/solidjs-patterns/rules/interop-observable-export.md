---
title: Use observable to Export Signals to External Libraries
impact: LOW
impactDescription: "manual subscription glue code"
tags: observable, RxJS, interop, signals
---

## Use observable to Export Signals to External Libraries

**Impact: LOW (manual subscription glue code)**

When you need to expose a SolidJS signal to an external library that expects an Observable (RxJS, analytics pipelines, logging systems), use the `observable` utility instead of manually wiring up subscriptions with `createEffect`.

**Incorrect (manual effect-based bridge):**

```typescript
import { createEffect } from "solid-js"
import { Subject } from "rxjs"
import { debounceTime, distinctUntilChanged } from "rxjs/operators"

const [searchTerm, setSearchTerm] = createSignal("")
const search$ = new Subject<string>()

// Manual bridge — must manage lifecycle yourself
createEffect(() => {
  search$.next(searchTerm())
})

search$.pipe(
  debounceTime(300),
  distinctUntilChanged()
).subscribe(term => performSearch(term))
```

**Correct (observable creates the bridge automatically):**

```typescript
import { observable, createSignal } from "solid-js"
import { from as rxFrom, debounceTime, distinctUntilChanged } from "rxjs"

const [searchTerm, setSearchTerm] = createSignal("")

// Converts signal to standard Observable — lifecycle managed by Solid
const search$ = rxFrom(observable(searchTerm))

search$.pipe(
  debounceTime(300),
  distinctUntilChanged()
).subscribe(term => performSearch(term))
```

**Notes:**
- `observable` returns a standard TC39 Observable that emits whenever the signal changes
- The subscription is tied to the reactive owner scope and auto-cleans on disposal
- Use `from` (the SolidJS utility) for the reverse direction: external subscriptions into Solid signals
- Only use `observable` when you genuinely need RxJS operators or external library integration; for Solid-to-Solid communication, use signals directly

Reference: [SolidJS observable docs](https://docs.solidjs.com/reference/secondary-primitives/observable)
