---
title: Use Computed Getters in Stores for Derived Reactive Properties
impact: MEDIUM
impactDescription: "stale derived values or unnecessary effects to keep store properties in sync"
tags: state, store, getters, derived, reactivity
---

## Use Computed Getters in Stores for Derived Reactive Properties

**Impact: MEDIUM (stale derived values or unnecessary effects to keep store properties in sync)**

When a store property should be derived from other state (props, signals, or other store fields), define it as a getter in the initial `createStore` object. Getters are re-evaluated on each access, maintaining reactivity through the store proxy.

**Incorrect (captured once — goes stale):**

```typescript
const [state, setState] = createStore({
  firstName: "John",
  lastName: "Doe",
  fullName: "John Doe",  // BAD: static string, never updates
})
```

**Incorrect (effect to sync — overly complex):**

```typescript
const [state, setState] = createStore({ firstName: "John", lastName: "Doe", fullName: "" })

// BAD: unnecessary effect, extra update cycle
createEffect(() => {
  setState("fullName", `${state.firstName} ${state.lastName}`)
})
```

**Correct (getter — always current, zero overhead):**

```typescript
const [state, setState] = createStore({
  firstName: "John",
  lastName: "Doe",
  get fullName() { return `${this.firstName} ${this.lastName}` },
})

// state.fullName is always "John Doe" — updates when firstName or lastName change
setState("firstName", "Jane")  // state.fullName is now "Jane Doe"
```

**Pattern: Bridge props into store with getters (from Hope UI, CodeImage):**

```typescript
const [state, setState] = createStore({
  headerMounted: false,
  bodyMounted: false,
  // Reactive bridge from props — always reflects current prop value
  get opened() { return props.opened },
  get size() { return props.size ?? "md" },
  get dialogId() { return props.id ?? defaultId },
  get headerId() { return `${this.dialogId}--header` },
})
```

**Pattern: Controlled/uncontrolled component with getter:**

```typescript
const [state, setState] = createStore({
  _internalValue: props.defaultValue ?? "",
  get isControlled() { return props.value !== undefined },
  get value() { return this.isControlled ? props.value : this._internalValue },
})
```

**Notes:**
- Getters in stores use `this` to reference sibling properties — they compose naturally
- Getters are NOT cached like `createMemo` — if the computation is expensive, combine with `createMemo` outside the store
- This pattern replaces the common anti-pattern of syncing store state with effects
- Classes (`Date`, `Map`, `Set`) are not wrapped by store proxies — getters returning these won't have granular reactivity on their internal properties

Reference: [SolidJS Stores](https://docs.solidjs.com/concepts/stores)
