---
title: Lazy Load Heavy Components
impact: MEDIUM
impactDescription: 30-60% initial bundle reduction for modal-heavy apps
tags: performance, lazy, code-splitting, bundle, dynamic-import
---

## Lazy Load Heavy Components

**Impact: MEDIUM (30-60% initial bundle reduction for modal-heavy apps)**

Use `lazy()` for components that aren't visible on initial render: modals, settings panels, charts, editors. Don't lazy load small components — the overhead isn't worth it.

**When to lazy load:**

```typescript
import { lazy } from "solid-js"

// ✅ DO lazy load: modals, charts, editors, large forms
const SettingsModal = lazy(() => import("./modals/SettingsModal"))
const MarkdownEditor = lazy(() => import("./components/MarkdownEditor"))
const DataVisualization = lazy(() => import("./components/DataVisualization"))

// ❌ DON'T lazy load: small components, frequently-used UI elements
// const Badge = lazy(() => import("./Badge"))  // Overhead not worth it
```

**Route-level splitting:**

```typescript
import { lazy } from "solid-js"
import { Route } from "@solidjs/router"

const Home = lazy(() => import("./screens/Home"))
const Settings = lazy(() => import("./screens/Settings"))
const Profile = lazy(() => import("./screens/Profile"))

function App() {
  return (
    <Routes>
      <Route path="/" component={Home} />
      <Route path="/settings" component={Settings} />
      <Route path="/profile" component={Profile} />
    </Routes>
  )
}
```

Always pair with Suspense and skeleton components for a smooth loading experience.

Reference: [SolidJS lazy](https://docs.solidjs.com/reference/component-apis/lazy)
