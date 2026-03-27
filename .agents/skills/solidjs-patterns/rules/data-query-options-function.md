---
title: Wrap Query Options in Arrow Function
impact: HIGH
impactDescription: Reactive query keys don't update — queries never refetch
tags: data-fetching, solid-query, reactivity, signals
---

## Wrap Query Options in Arrow Function

**Impact: HIGH (reactive query keys don't update — queries never refetch)**

In Solid Query, options must be wrapped in a function `() => ({...})` to enable reactive query keys. This is different from React Query's plain object.

**Incorrect (plain object — query keys don't react to signal changes):**

```typescript
// React Query pattern — WRONG in Solid Query
const query = createQuery({
  queryKey: ["user", userId()],
  queryFn: () => fetchUser(userId()),
})
```

**Correct (arrow function wrapper enables reactivity):**

```typescript
const query = createQuery(() => ({
  queryKey: ["user", userId()],  // userId is a signal — re-fetches when it changes
  queryFn: () => fetchUser(userId()),
}))
```

This applies to `createQuery`, `createMutation`, and `createInfiniteQuery`.

Reference: [TanStack Solid Query Overview](https://tanstack.com/query/latest/docs/solid/overview)
