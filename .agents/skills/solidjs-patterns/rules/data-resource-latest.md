---
title: Use resource.latest for Consistent Stale-While-Revalidate UI
impact: MEDIUM
impactDescription: "inconsistent data display during error states and initial loads"
tags: data, resource, stale-while-revalidate, UX
---

## Use resource.latest for Consistent Stale-While-Revalidate UI

**Impact: MEDIUM (inconsistent data display during error states and initial loads)**

`resource()` and `resource.latest` both retain the previous value during refetch (state: `"refreshing"`). The key difference is error handling: `resource()` throws on error (triggering ErrorBoundary), while `resource.latest` returns the last successful value. Use `resource.latest` when you want to keep showing data even after an error, and pair with `resource.loading` / `resource.state` for loading indicators.

**Basic pattern — loading indicator without Suspense fallback flash:**

```typescript
const [page, setPage] = createSignal(1)
const [data] = createResource(page, fetchPage)

return (
  <div>
    <Show when={data.loading}>
      <div class="overlay-spinner" />  {/* Subtle loading indicator */}
    </Show>
    <div style={{ opacity: data.loading ? 0.6 : 1 }}>
      {data.latest?.title}  {/* Shows previous page during load AND errors */}
    </div>
  </div>
)
```

**resource() vs resource.latest:**

| Accessor | Initial Load | Refetch (`"refreshing"`) | On Error |
|----------|-------------|--------------------------|----------|
| `resource()` | `undefined` | Previous value | Throws (triggers ErrorBoundary) |
| `resource.latest` | `undefined` | Previous value | Last successful value |

**When resource.latest matters most — error resilience:**

```typescript
// resource() throws on error → ErrorBoundary catches it, UI replaced
// resource.latest returns last good value → data stays visible

<ErrorBoundary fallback={<ErrorPanel />}>
  <div>{data()?.title}</div>  {/* Replaced by ErrorPanel on error */}
</ErrorBoundary>

// vs

<div>
  <Show when={data.error}>
    <div class="error-banner">{data.error.message}</div>
  </Show>
  <div>{data.latest?.title}</div>  {/* Still shows last successful data */}
</div>
```

**Combine with useTransition for route-level transitions:**

```typescript
const [isPending, start] = useTransition()
const navigate = (page: number) => start(() => setPage(page))

// isPending() is true while new data loads — dim the current content
<div style={{ opacity: isPending() ? 0.6 : 1 }}>
  <PageContent data={data} />
</div>
```

**With initialValue for type safety:**

```typescript
// Without initialValue: data() can be undefined during initial load
const [data] = createResource(source, fetcher)

// With initialValue: data() always returns T (never undefined)
const [data] = createResource(source, fetcher, { initialValue: [] })
// data.latest is also always T
```

**Notes:**
- During refetch, both `resource()` and `resource.latest` return the previous value — the difference is only on error
- `resource.latest` is most valuable for error-resilient UIs where you want data to remain visible
- Use `resource.state` for fine-grained status: `"unresolved"`, `"pending"`, `"ready"`, `"refreshing"`, `"errored"`
- Pair with `data.loading` for subtle loading indicators (opacity, overlay spinners)
- This pattern is especially valuable for pagination, search-as-you-type, and dashboard auto-refresh

Reference: [SolidJS createResource](https://docs.solidjs.com/reference/basic-reactivity/create-resource)
