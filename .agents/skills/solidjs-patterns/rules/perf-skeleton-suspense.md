---
title: Use Skeleton Components as Suspense Fallbacks
impact: MEDIUM
impactDescription: "layout shift and visual jank during loading"
tags: Suspense, skeleton, loading, layout shift, UX
---

## Use Skeleton Components as Suspense Fallbacks

**Impact: MEDIUM (layout shift and visual jank during loading)**

Generic spinners or "Loading..." text inside Suspense fallbacks cause layout shift when the real content arrives. Use skeleton components that match the final layout dimensions so the page stays stable during loading.

**Incorrect (generic fallback causes layout shift):**

```typescript
<Suspense fallback={<p>Loading...</p>}>
  <Dashboard />  {/* When this loads, entire layout jumps */}
</Suspense>
```

**Correct (skeleton matches final dimensions):**

```typescript
function CardSkeleton() {
  return (
    <div class="animate-pulse">
      <div class="h-4 bg-muted rounded w-3/4 mb-2" />
      <div class="h-4 bg-muted rounded w-1/2" />
    </div>
  )
}

function DashboardSkeleton() {
  return (
    <div class="grid grid-cols-3 gap-4">
      <CardSkeleton />
      <CardSkeleton />
      <CardSkeleton />
    </div>
  )
}

<Suspense fallback={<DashboardSkeleton />}>
  <Dashboard />
</Suspense>
```

**Notes:**
- Compose small skeleton primitives into page-level skeletons that mirror actual layout
- For app-level loading, wrap the router in a Suspense with a full-page skeleton (sidebar + header + content area)
- Skeletons should use the same grid, flex, and spacing as the real content
- Tailwind's `animate-pulse` class provides the standard shimmer effect

Reference: [SolidJS Suspense docs](https://docs.solidjs.com/reference/components/suspense)
