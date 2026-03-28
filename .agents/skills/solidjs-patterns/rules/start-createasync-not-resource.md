---
title: Use createAsync + query() for Data Loading in SolidStart
impact: HIGH
impactDescription: Missing cache dedup, improper invalidation, waterfall fetches
tags: solidstart, createAsync, query, createResource, data-fetching, routing
---

## Use createAsync + query() for Data Loading in SolidStart

**Impact: HIGH (missing cache dedup, improper invalidation, waterfall fetches)**

SolidStart's modern data fetching pattern uses `query()` for cached server functions and `createAsync` for non-blocking consumption. `createResource` is the lower-level primitive — it doesn't integrate with SolidStart's cache or router preloading.

**Incorrect (createResource — no cache dedup or preloading):**

```typescript
function UserPage() {
  const params = useParams()
  const [user] = createResource(
    () => params.id,
    (id) => fetchUser(id)
  )
  return <Show when={user()}>{u => <Profile user={u()} />}</Show>
}
```

**Correct (query + createAsync — cached, deduped, preloadable):**

```typescript
import { query, createAsync } from "@solidjs/router"

const getUser = query(async (id: string) => {
  "use server"
  return db.users.findUnique({ where: { id } })
}, "user")

// Route preload
export const route = {
  load: ({ params }) => getUser(params.id)
}

function UserPage() {
  const params = useParams()
  const user = createAsync(() => getUser(params.id))
  return <Show when={user()}>{u => <Profile user={u()} />}</Show>
}
```

**Key benefits of query + createAsync:**

- Automatic deduplication — 2 identical requests never fly out
- Route preloading — data fetches start during navigation, not after render
- Cache invalidation via `revalidate()`
- Non-blocking — renders using Suspense boundaries, no waterfalls

Reference: [SolidStart Data Loading](https://docs.solidjs.com/solid-start/building-your-application/data-loading)
