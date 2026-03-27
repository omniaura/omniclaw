---
title: Wrap Risky Components in ErrorBoundary
impact: HIGH
impactDescription: "unhandled errors crash entire component tree"
tags: ErrorBoundary, error handling, resilience
---

## Wrap Risky Components in ErrorBoundary

**Impact: HIGH (unhandled errors crash entire component tree)**

An uncaught error in any component propagates up and can tear down the entire app. Use `<ErrorBoundary>` to isolate failures and provide recovery UI. Place boundaries around data-dependent sections, third-party components, and user-generated content renderers.

**Incorrect (no error boundary — one component crash kills the app):**

```typescript
function App() {
  return (
    <div>
      <Header />
      <UserGeneratedContent />  {/* If this throws, the whole app dies */}
      <Footer />
    </div>
  )
}
```

**Correct (ErrorBoundary isolates the failure):**

```typescript
import { ErrorBoundary } from "solid-js"

function App() {
  return (
    <div>
      <Header />
      <ErrorBoundary fallback={(err, reset) => (
        <div class="error-panel">
          <p>Something went wrong: {err.message}</p>
          <button onClick={reset}>Try Again</button>
        </div>
      )}>
        <UserGeneratedContent />
      </ErrorBoundary>
      <Footer />
    </div>
  )
}
```

**Notes:**
- The `fallback` receives the error object and a `reset` function that re-mounts the children
- Place boundaries strategically: around route content, modals, and any component that parses external data
- ErrorBoundary does not catch errors in event handlers or async code — only in the render/reactive tree
- Nest boundaries for granularity: an outer boundary for the page, inner boundaries for widgets

Reference: [SolidJS ErrorBoundary docs](https://docs.solidjs.com/reference/components/error-boundary)
