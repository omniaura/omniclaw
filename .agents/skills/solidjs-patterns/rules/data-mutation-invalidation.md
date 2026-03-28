---
title: Invalidate Queries After Mutations
impact: HIGH
tags: data, solid-query, mutation, cache
---

## Invalidate Queries After Mutations

**Impact: HIGH (stale UI after mutations causes user confusion)**

After a successful mutation with Solid Query, always invalidate related queries to refetch fresh data. Without invalidation, the UI shows stale cached data until the next automatic refetch.

**Incorrect (mutation without cache invalidation):**

```typescript
const mutation = createMutation(() => ({
  mutationFn: (data: UserUpdate) => updateUser(props.userId, data),
  // ❌ No onSuccess — cached user data is now stale
}));
```

**Correct (invalidate related queries on success):**

```typescript
import { createMutation, useQueryClient } from "@tanstack/solid-query"

function UpdateButton(props: { userId: string }) {
  const queryClient = useQueryClient()

  const mutation = createMutation(() => ({
    mutationFn: (data: UserUpdate) => updateUser(props.userId, data),
    onSuccess: () => {
      // ✅ Invalidate and refetch the user query
      queryClient.invalidateQueries({ queryKey: ["user", props.userId] })
    },
  }))

  return (
    <button
      onClick={() => mutation.mutate({ name: "New Name" })}
      disabled={mutation.isPending}
    >
      {mutation.isPending ? "Saving..." : "Save"}
    </button>
  )
}
```

**Notes:**

- Use `queryClient.invalidateQueries()` with the query key to mark cached data as stale
- For optimistic updates, use `onMutate` to update the cache before the server responds
- Invalidate with partial keys to refetch related queries: `{ queryKey: ["users"] }` invalidates all user queries
- Wrap the mutation options in an arrow function (Solid Query requires it for reactivity)
