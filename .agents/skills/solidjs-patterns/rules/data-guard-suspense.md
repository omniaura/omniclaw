---
title: Guard .data Access to Prevent Unwanted Suspense
impact: CRITICAL
impactDescription: Entire UI replaced by skeleton when any query loads
tags: data-fetching, solid-query, suspense, loading
---

## Guard .data Access to Prevent Unwanted Suspense

**Impact: CRITICAL (entire UI replaced by skeleton when any query loads)**

In Solid Query, queries suspend by DEFAULT inside Suspense boundaries. Accessing `query.data` while loading triggers Suspense — the nearest boundary shows its fallback, potentially replacing your entire UI.

**Incorrect (accessing .data triggers Suspense — whole app shows skeleton):**

```typescript
const showSalesPitch = createMemo(
  () => paymentError() || (user.data?.balance ?? 1_000_000_000) <= 0
)
// When user query is loading, this accesses user.data → SUSPENDS → whole app skeleton!
```

**Correct (guard .data access with .isLoading check):**

```typescript
const showSalesPitch = createMemo(
  () => paymentError() ||
    (user.isLoading ? false : (user.data?.balance ?? 1_000_000_000) <= 0)
)
// When loading, returns safe default without accessing .data → NO SUSPENSION
```

**The pattern:** Always check `.isLoading` before `.data`:

```typescript
// For boolean decisions
query.isLoading ? defaultValue : query.data?.someProperty

// For rendering
<Show when={!query.isLoading && query.data}>
  {(data) => <Component data={data()} />}
</Show>
```

**Alternative: Inner Suspense boundaries** to isolate suspension:

```typescript
<Suspense fallback={<AppSkeleton />}>
  <Layout>
    <ChatFeed />
    <Suspense fallback={<SendMessageSkeleton />}>
      <SendMessage />  {/* Query suspension isolated here */}
    </Suspense>
  </Layout>
</Suspense>
```

Reference: [SolidJS Suspense](https://docs.solidjs.com/reference/components/suspense)
