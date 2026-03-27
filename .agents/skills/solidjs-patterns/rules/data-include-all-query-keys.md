---
title: Include All Dependencies in Query Keys
impact: HIGH
impactDescription: Stale data served from wrong cache entry
tags: data-fetching, solid-query, query-keys, caching
---

## Include All Dependencies in Query Keys

**Impact: HIGH (stale data served from wrong cache entry)**

Query keys determine cache identity. Missing a dependency means different requests share the same cache, returning stale or wrong data.

**Incorrect (query key missing userId — always hits same cache):**

```typescript
function UserPosts(props: { userId: Accessor<string> }) {
  const query = createQuery(() => ({
    queryKey: ["posts"],  // Missing userId!
    queryFn: () => fetchPosts(props.userId()),
  }))
}
```

**Correct (query key includes all dependencies):**

```typescript
function UserPosts(props: { userId: Accessor<string> }) {
  const query = createQuery(() => ({
    queryKey: ["posts", props.userId()],  // Cache is per-user
    queryFn: () => fetchPosts(props.userId()),
  }))
}
```

Reference: [TanStack Query Keys](https://tanstack.com/query/latest/docs/framework/solid/guides/query-keys)
