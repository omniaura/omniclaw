---
title: Use lazy() for Route-Level Code Splitting
impact: HIGH
tags: performance, code-splitting, lazy, routing
---

## Use lazy() for Route-Level Code Splitting

**Impact: HIGH (reduces initial bundle by 40-70% in multi-route apps)**

Use `lazy()` to split each route into its own chunk. This is the highest-impact code splitting strategy — users only download the code for the route they visit. Combine with Suspense for loading states.

**Incorrect (all routes in main bundle):**

```typescript
import Home from "./screens/Home"
import Settings from "./screens/Settings"
import Profile from "./screens/Profile"
import Admin from "./screens/Admin"

// ❌ All 4 screens included in initial bundle
function App() {
  return (
    <Routes>
      <Route path="/" component={Home} />
      <Route path="/settings" component={Settings} />
      <Route path="/profile" component={Profile} />
      <Route path="/admin" component={Admin} />
    </Routes>
  )
}
```

**Correct (lazy-loaded route chunks):**

```typescript
import { lazy } from "solid-js"
import { Route, Routes } from "@solidjs/router"

const Home = lazy(() => import("./screens/Home"))
const Settings = lazy(() => import("./screens/Settings"))
const Profile = lazy(() => import("./screens/Profile"))
const Admin = lazy(() => import("./screens/Admin"))

function App() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Routes>
        <Route path="/" component={Home} />
        <Route path="/settings" component={Settings} />
        <Route path="/profile" component={Profile} />
        <Route path="/admin" component={Admin} />
      </Routes>
    </Suspense>
  )
}
```

**Notes:**

- Only lazy-load routes and heavy components (modals, charts, editors) — small components aren't worth the overhead
- Combine with route preloading (`preload` in SolidStart) to start loading before navigation
- Target < 50KB per route chunk for optimal loading
- Don't lazy-load the home/landing route — it should be in the main bundle
