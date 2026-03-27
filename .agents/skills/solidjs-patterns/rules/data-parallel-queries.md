---
title: Don't Create Query Waterfalls
impact: CRITICAL
impactDescription: 2-5× slower load times from sequential fetching
tags: data-fetching, waterfalls, parallel, solid-query, performance
---

## Don't Create Query Waterfalls

**Impact: CRITICAL (2-5× slower load times from sequential fetching)**

Independent queries should fetch in parallel. Don't gate one query on another unless there's a true data dependency.

**Incorrect (unnecessary waterfall — second query waits for first):**

```typescript
function Dashboard() {
  const usersQuery = createQuery(() => ({
    queryKey: ["users"],
    queryFn: fetchUsers,
  }))

  const statsQuery = createQuery(() => ({
    queryKey: ["stats"],
    queryFn: fetchStats,
    enabled: !!usersQuery.data,  // Unnecessary dependency!
  }))
}
```

**Correct (independent queries fetch in parallel):**

```typescript
function Dashboard() {
  const usersQuery = createQuery(() => ({
    queryKey: ["users"],
    queryFn: fetchUsers,
  }))

  const statsQuery = createQuery(() => ({
    queryKey: ["stats"],
    queryFn: fetchStats,
    // No enabled — fetches immediately in parallel
  }))
}
```

Only use `enabled` when there's a genuine data dependency (e.g., fetch user's posts after user ID is known).

Reference: [TanStack Query Dependent Queries](https://tanstack.com/query/latest/docs/framework/solid/guides/dependent-queries)
