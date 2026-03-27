---
title: Never Destructure Solid Query Results
impact: CRITICAL
impactDescription: Query state frozen — loading/error/data never update
tags: data-fetching, solid-query, destructuring, reactivity
---

## Never Destructure Solid Query Results

**Impact: CRITICAL (query state frozen — loading/error/data never update)**

Solid Query returns reactive proxies, not plain objects. Destructuring captures values once at creation time. This is the #1 migration gotcha from React Query.

**Incorrect (destructured values are static snapshots):**

```typescript
const { data, isLoading, error } = createQuery(() => ({
  queryKey: ["users"],
  queryFn: fetchUsers,
}))

// data, isLoading, error NEVER update
return <div>{isLoading ? "Loading..." : data?.length}</div>
```

**Correct (access properties on query object in JSX):**

```typescript
const query = createQuery(() => ({
  queryKey: ["users"],
  queryFn: fetchUsers,
}))

// Properties accessed in reactive context = automatic updates
return <div>{query.isLoading ? "Loading..." : query.data?.length}</div>
```

Reference: [TanStack Solid Query](https://tanstack.com/query/latest/docs/solid/overview)
