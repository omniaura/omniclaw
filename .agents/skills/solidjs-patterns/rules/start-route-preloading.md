---
title: Always Define Route Preload Functions
impact: HIGH
impactDescription: Data fetches delayed until after navigation completes and component renders
tags: solidstart, routing, preload, load, data-fetching, performance
---

## Always Define Route Preload Functions

**Impact: HIGH (data fetches delayed until after navigation completes and component renders)**

Without a `load` function, data fetching only starts when the route component renders. With preloading, data fetching starts during navigation — the page appears ready faster.

**Incorrect (no preload — fetch starts after render):**

```typescript
// routes/users/[id].tsx
function UserPage() {
  const params = useParams()
  const user = createAsync(() => getUser(params.id))
  // Fetch starts AFTER route component renders
  return <Suspense><Profile user={user()} /></Suspense>
}
```

**Correct (route preload — fetch starts during navigation):**

```typescript
// routes/users/[id].tsx
import { query, createAsync } from "@solidjs/router"

const getUser = query(async (id: string) => {
  "use server"
  return db.users.findUnique({ where: { id } })
}, "user")

export const route = {
  load: ({ params }) => getUser(params.id)  // Fetch starts during navigation
}

function UserPage() {
  const params = useParams()
  const user = createAsync(() => getUser(params.id))
  // Data may already be available by the time component renders
  return <Suspense><Profile user={user()} /></Suspense>
}
```

Reference: [SolidStart Routing](https://docs.solidjs.com/solid-start/building-your-application/routing)
