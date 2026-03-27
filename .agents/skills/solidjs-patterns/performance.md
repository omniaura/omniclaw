# SolidJS Performance Patterns

Patterns for code splitting, lazy loading, and optimizing bundle size.

## LazyShow vs Suspense

**Prefer LazyShow for modals and conditional UI** - Suspense can cause layout flicker.

```typescript
import { lazy, Show, Suspense } from "solid-js"

// ❌ AVOID: Suspense for modals causes layout issues
const HeavyModal = lazy(() => import("./HeavyModal"))

function App() {
  return (
    <Suspense fallback={<Loading />}>
      <Show when={isOpen()}>
        <HeavyModal />  {/* Suspense boundary causes flicker */}
      </Show>
    </Suspense>
  )
}

// ✅ PREFER: LazyShow pattern for modals
import { LazyShow } from "@/components/ui/LazyShow"

function App() {
  return (
    <LazyShow when={isOpen()}>
      {(Modal) => <Modal onClose={close} />}
    </LazyShow>
  )
}
```

### LazyShow Implementation Pattern

```typescript
import { Show, Suspense, lazy, type Component } from "solid-js"

interface LazyShowProps<T> {
  when: T | undefined | null | false
  fallback?: JSX.Element
  children: (value: NonNullable<T>) => JSX.Element
}

export function LazyShow<T>(props: LazyShowProps<T>) {
  return (
    <Show when={props.when}>
      {(value) => (
        <Suspense fallback={props.fallback}>
          {props.children(value())}
        </Suspense>
      )}
    </Show>
  )
}
```

## Code Splitting Strategies

### Route-Level Splitting

```typescript
import { lazy } from "solid-js"
import { Route } from "@solidjs/router"

// Each route loads its own chunk
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

### Modal/Heavy Component Splitting

```typescript
// Don't lazy load small components - overhead not worth it
// DO lazy load: modals, charts, editors, large forms

const SettingsModal = lazy(() => import("./modals/SettingsModal"))
const MarkdownEditor = lazy(() => import("./components/MarkdownEditor"))
const DataVisualization = lazy(() => import("./components/DataVisualization"))
```

## Skeleton Components

Use skeletons during Suspense to prevent layout shift:

```typescript
// ✅ Skeleton matches final component dimensions
function CardSkeleton() {
  return (
    <div class="animate-pulse">
      <div class="h-4 bg-muted rounded w-3/4 mb-2" />
      <div class="h-4 bg-muted rounded w-1/2" />
    </div>
  )
}

// ✅ Compose skeletons for complex layouts
function DashboardSkeleton() {
  return (
    <div class="grid grid-cols-3 gap-4">
      <CardSkeleton />
      <CardSkeleton />
      <CardSkeleton />
    </div>
  )
}

// Usage with Suspense
<Suspense fallback={<DashboardSkeleton />}>
  <Dashboard />
</Suspense>
```

### App-Level Skeleton Pattern

```typescript
// Wrap entire app in skeleton during initial load
function AppSkeleton() {
  return (
    <div class="flex h-screen">
      <SidebarSkeleton />
      <main class="flex-1">
        <HeaderSkeleton />
        <ContentSkeleton />
      </main>
    </div>
  )
}

function App() {
  return (
    <Suspense fallback={<AppSkeleton />}>
      <Router>
        {/* Routes */}
      </Router>
    </Suspense>
  )
}
```

## Memoization for Expensive Computations

```typescript
import { createMemo } from "solid-js"

// ✅ Memoize expensive markdown rendering
const renderedContent = createMemo(() => {
  const raw = content()
  if (!raw) return ""
  return renderMarkdown(raw) // Only re-runs when content() changes
})

// ✅ Memoize filtered/sorted lists
const sortedItems = createMemo(() =>
  items()
    .filter(item => item.active)
    .sort((a, b) => a.name.localeCompare(b.name))
)

// ❌ Don't memoize simple property access
// This adds overhead without benefit
const name = createMemo(() => user().name) // Unnecessary
```

## Bundle Analysis

Use visualization tools to identify large chunks:

```bash
# Generate bundle stats
bun run build -- --analyze

# Or use rollup-plugin-visualizer in vite.config.ts
```

### Common Bundle Bloat Sources

| Library | Size | Alternative |
|---------|------|-------------|
| moment.js | ~300KB | date-fns (~30KB) or dayjs (~7KB) |
| lodash (full) | ~70KB | lodash-es with tree shaking |
| markdown-it + plugins | ~50KB+ | Consider lazy loading |

## Performance Metrics

Track these metrics for optimization:

- **Initial bundle size**: Target < 200KB gzipped
- **Route chunk size**: Target < 50KB per route
- **Time to Interactive (TTI)**: Target < 3s on 3G
- **Largest Contentful Paint (LCP)**: Target < 2.5s

## Related Patterns

- See [State Patterns](state-patterns.md) for efficient data fetching
- See [Anti-Patterns](anti-patterns.md) for reactivity performance pitfalls
