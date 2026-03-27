# Solid Query Patterns

Solid Query (@tanstack/solid-query) brings TanStack Query to SolidJS with adaptations for fine-grained reactivity. Coming from React Query? Read on - there are important differences!

## Key Differences from React Query

### 1. No Destructuring Outside Reactive Context

This is the #1 gotcha. Query results are **proxies** that must be accessed reactively.

```typescript
// ❌ WRONG: Destructuring breaks reactivity
const { data, isLoading, error } = createQuery(() => ({
  queryKey: ["users"],
  queryFn: fetchUsers,
}))

// data, isLoading, error are now static snapshots - they won't update!
return <div>{isLoading ? "Loading..." : data?.length}</div>
```

```typescript
// ✅ CORRECT: Access properties on the query object in JSX
const query = createQuery(() => ({
  queryKey: ["users"],
  queryFn: fetchUsers,
}))

// Properties accessed in JSX reactive context = automatic updates
return <div>{query.isLoading ? "Loading..." : query.data?.length}</div>
```

### 2. Automatic Suspense Support

Solid Query integrates natively with SolidJS Suspense - no extra configuration needed.

```typescript
// React Query: need to configure suspense option
const { data } = useQuery({
  queryKey: ["users"],
  queryFn: fetchUsers,
  suspense: true,  // Extra config needed
})

// Solid Query: wrap in Suspense and it just works
<Suspense fallback={<Loading />}>
  <UserList />  {/* Query inside automatically suspends */}
</Suspense>
```

### 3. Fine-Grained Reactivity (No notifyOnChangeProps)

React Query needs `notifyOnChangeProps` to optimize re-renders. Solid Query doesn't - it tracks automatically.

```typescript
// React Query: must specify which props trigger re-renders
const { data } = useQuery({
  queryKey: ["users"],
  queryFn: fetchUsers,
  notifyOnChangeProps: ["data"],  // Only re-render when data changes
})

// Solid Query: just use what you need - SolidJS tracks it automatically
const query = createQuery(() => ({
  queryKey: ["users"],
  queryFn: fetchUsers,
}))

// Only re-runs when query.data changes, not when isLoading/isFetching change
<div>{query.data?.length}</div>
```

### 4. Query Options are Functions

In Solid Query, options must be wrapped in a function to enable reactive query keys.

```typescript
// React Query: plain object
useQuery({
  queryKey: ["user", userId],
  queryFn: () => fetchUser(userId),
})

// Solid Query: arrow function wrapper
createQuery(() => ({
  queryKey: ["user", userId()],  // userId is a signal
  queryFn: () => fetchUser(userId()),
}))
```

---

## Core Patterns

### Basic Query Pattern

```typescript
import { createQuery } from "@tanstack/solid-query"

function UserProfile(props: { userId: string }) {
  const query = createQuery(() => ({
    queryKey: ["user", props.userId],
    queryFn: () => fetchUser(props.userId),
    staleTime: 5 * 60 * 1000,  // 5 minutes
  }))

  return (
    <div>
      <Show when={query.isLoading}>
        <Spinner />
      </Show>
      <Show when={query.error}>
        <ErrorMessage error={query.error} />
      </Show>
      <Show when={query.data}>
        <UserCard user={query.data!} />
      </Show>
    </div>
  )
}
```

### Switch/Match for Query States

Use `Switch`/`Match` for cleaner state handling when states are mutually exclusive.

```typescript
import { Switch, Match } from "solid-js"

function UserProfile(props: { userId: string }) {
  const query = createQuery(() => ({
    queryKey: ["user", props.userId],
    queryFn: () => fetchUser(props.userId),
  }))

  return (
    <Switch>
      <Match when={query.isPending}>
        <Skeleton />
      </Match>
      <Match when={query.isError}>
        <ErrorState error={query.error} retry={query.refetch} />
      </Match>
      <Match when={query.isSuccess}>
        <UserCard user={query.data!} />
      </Match>
    </Switch>
  )
}
```

### Suspense Boundaries

Wrap query consumers in Suspense for automatic loading states.

```typescript
import { Suspense, ErrorBoundary } from "solid-js"

function App() {
  return (
    <ErrorBoundary fallback={(err) => <ErrorPage error={err} />}>
      <Suspense fallback={<PageSkeleton />}>
        <Dashboard />
      </Suspense>
    </ErrorBoundary>
  )
}

// Inside Dashboard, queries automatically suspend
function Dashboard() {
  const statsQuery = createQuery(() => ({
    queryKey: ["dashboard", "stats"],
    queryFn: fetchDashboardStats,
  }))

  // No loading check needed - Suspense handles it
  return <StatsGrid stats={statsQuery.data!} />
}
```

### Error Boundaries with throwOnError

Use `throwOnError` to let errors bubble to ErrorBoundary.

```typescript
function UserList() {
  const query = createQuery(() => ({
    queryKey: ["users"],
    queryFn: fetchUsers,
    throwOnError: true,  // Errors thrown to nearest ErrorBoundary
  }))

  // Only renders when query succeeds
  return (
    <For each={query.data}>
      {(user) => <UserCard user={user} />}
    </For>
  )
}

// Parent provides error handling
function UsersPage() {
  return (
    <ErrorBoundary fallback={(err) => <UserListError error={err} />}>
      <Suspense fallback={<UserListSkeleton />}>
        <UserList />
      </Suspense>
    </ErrorBoundary>
  )
}
```

### Conditional Queries with Signals

Use the `enabled` option with signals for conditional fetching.

```typescript
function ConversationMessages(props: { conversationId: Accessor<string | null> }) {
  const query = createQuery(() => ({
    queryKey: ["messages", props.conversationId()],
    queryFn: () => fetchMessages(props.conversationId()!),
    enabled: !!props.conversationId(),  // Only fetch when ID exists
  }))

  return (
    <Show when={props.conversationId()} fallback={<SelectConversation />}>
      <Switch>
        <Match when={query.isPending}>
          <MessagesSkeleton />
        </Match>
        <Match when={query.data}>
          <MessageList messages={query.data!} />
        </Match>
      </Switch>
    </Show>
  )
}
```

### Infinite Queries

```typescript
import { createInfiniteQuery } from "@tanstack/solid-query"

function MessageHistory(props: { conversationId: string }) {
  const query = createInfiniteQuery(() => ({
    queryKey: ["messages", props.conversationId],
    queryFn: ({ pageParam }) => fetchMessages(props.conversationId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    getPreviousPageParam: (firstPage) => firstPage.prevCursor,
  }))

  const allMessages = () => query.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <div>
      <Show when={query.hasPreviousPage}>
        <button
          onClick={() => query.fetchPreviousPage()}
          disabled={query.isFetchingPreviousPage}
        >
          {query.isFetchingPreviousPage ? "Loading..." : "Load older"}
        </button>
      </Show>

      <For each={allMessages()}>
        {(message) => <Message data={message} />}
      </For>

      <Show when={query.hasNextPage}>
        <button
          onClick={() => query.fetchNextPage()}
          disabled={query.isFetchingNextPage}
        >
          {query.isFetchingNextPage ? "Loading..." : "Load newer"}
        </button>
      </Show>
    </div>
  )
}
```

### Mutations

```typescript
import { createMutation, useQueryClient } from "@tanstack/solid-query"

function AddUserForm() {
  const queryClient = useQueryClient()

  const mutation = createMutation(() => ({
    mutationFn: (newUser: CreateUserInput) => createUser(newUser),
    onSuccess: () => {
      // Invalidate and refetch users list
      queryClient.invalidateQueries({ queryKey: ["users"] })
    },
  }))

  const handleSubmit = (e: Event) => {
    e.preventDefault()
    const formData = new FormData(e.target as HTMLFormElement)
    mutation.mutate({
      name: formData.get("name") as string,
      email: formData.get("email") as string,
    })
  }

  return (
    <form onSubmit={handleSubmit}>
      <input name="name" required />
      <input name="email" type="email" required />
      <button type="submit" disabled={mutation.isPending}>
        {mutation.isPending ? "Creating..." : "Add User"}
      </button>
      <Show when={mutation.isError}>
        <p class="error">{mutation.error?.message}</p>
      </Show>
    </form>
  )
}
```

---

## Common Mistakes

### Mistake 1: Destructuring Query Results

```typescript
// ❌ WRONG: Values captured once, never update
const { data, isLoading } = createQuery(() => ({
  queryKey: ["users"],
  queryFn: fetchUsers,
}))

// ✅ CORRECT: Access on query object preserves reactivity
const query = createQuery(/* ... */)
// Use query.data, query.isLoading in JSX
```

### Mistake 2: Accessing Data Outside Reactive Context

```typescript
// ❌ WRONG: Accessing query.data outside JSX/effect
const query = createQuery(() => ({
  queryKey: ["user"],
  queryFn: fetchUser,
}))

const userName = query.data?.name  // Captured once at component creation!

return <div>{userName}</div>  // Won't update
```

```typescript
// ✅ CORRECT: Access inside JSX or createMemo
const query = createQuery(/* ... */)

// Option A: Direct in JSX
return <div>{query.data?.name}</div>

// Option B: Derived with createMemo
const userName = createMemo(() => query.data?.name)
return <div>{userName()}</div>
```

### Mistake 3: Waterfall Queries

```typescript
// ❌ WRONG: Second query waits for first unnecessarily
function Dashboard() {
  const usersQuery = createQuery(() => ({
    queryKey: ["users"],
    queryFn: fetchUsers,
  }))

  // This waits for usersQuery even though it doesn't depend on it
  const statsQuery = createQuery(() => ({
    queryKey: ["stats"],
    queryFn: fetchStats,
    enabled: !!usersQuery.data,  // Unnecessary dependency!
  }))
}
```

```typescript
// ✅ CORRECT: Independent queries fetch in parallel
function Dashboard() {
  const usersQuery = createQuery(() => ({
    queryKey: ["users"],
    queryFn: fetchUsers,
  }))

  const statsQuery = createQuery(() => ({
    queryKey: ["stats"],
    queryFn: fetchStats,
    // No enabled - fetches immediately in parallel
  }))
}
```

### Mistake 4: Missing Suspense Boundaries

```typescript
// ❌ WRONG: No Suspense but expecting automatic loading handling
function App() {
  return <UserProfile userId="123" />  // Will show nothing during load!
}

// Inside UserProfile, if using data directly without loading check:
function UserProfile(props) {
  const query = createQuery(/* ... */)
  return <div>{query.data!.name}</div>  // Crashes if data is undefined
}
```

```typescript
// ✅ CORRECT: Suspense boundary or explicit loading handling
function App() {
  return (
    <Suspense fallback={<ProfileSkeleton />}>
      <UserProfile userId="123" />
    </Suspense>
  )
}

// OR handle loading explicitly
function UserProfile(props) {
  const query = createQuery(/* ... */)
  return (
    <Show when={query.data} fallback={<ProfileSkeleton />}>
      {(data) => <div>{data().name}</div>}
    </Show>
  )
}
```

### Mistake 4b: Accessing `.data` Without Checking `.isLoading` (Triggers Suspense!)

**CRITICAL**: In solid-query, queries suspend by DEFAULT inside Suspense boundaries.
Unlike React Query where you opt-in with `suspense: true`, solid-query opts you IN automatically.

When you access `query.data` while the query is loading AND you're inside a Suspense boundary,
**the query will suspend and show the Suspense fallback**.

```typescript
// ❌ WRONG: Accessing .data without checking .isLoading triggers Suspense!
const showSalesPitch = createMemo(
  () => paymentError() || (user.data?.balance ?? 1_000_000_000) <= 0
)
// When user query is loading, this accesses user.data -> SUSPENDS -> whole app skeleton!
```

```typescript
// ✅ CORRECT: Guard .data access with .isLoading check
const showSalesPitch = createMemo(
  () => paymentError() ||
    (user.isLoading ? false : (user.data?.balance ?? 1_000_000_000) <= 0)
)
// When loading, returns safe default (false) without accessing .data -> NO SUSPENSION
```

**The Pattern**: Always check `.isLoading` before accessing `.data`:
```typescript
// For boolean decisions
query.isLoading ? defaultValue : query.data?.someProperty

// For rendering
<Show when={!query.isLoading && query.data}>
  {(data) => <Component data={data()} />}
</Show>
```

**Alternative approaches**:

1. **Inner Suspense boundaries** - isolate suspension to specific components:
```typescript
function App() {
  return (
    <Suspense fallback={<AppSkeleton />}>  {/* Catches lazy() chunk loading */}
      <Layout>
        <ChatFeed />
        <Suspense fallback={<SendMessageSkeleton />}>  {/* Catches user query suspension */}
          <SendMessage />
        </Suspense>
      </Layout>
    </Suspense>
  )
}
```

2. **Switch/Match for explicit state handling**:
```typescript
function SendMessage() {
  const userQuery = createQuery(/* ... */)

  return (
    <Switch>
      <Match when={userQuery.isPending}>
        <SendMessageSkeleton />
      </Match>
      <Match when={userQuery.data}>
        <ActualSendMessageUI user={userQuery.data!} />
      </Match>
    </Switch>
  )
}
```

**Preferred approach**: Guard `.data` access with `.isLoading` check. It's the simplest fix
and keeps the UI responsive without needing extra Suspense boundaries.

### Mistake 5: Stale Query Keys

```typescript
// ❌ WRONG: Query key doesn't include reactive dependency
function UserPosts(props: { userId: Accessor<string> }) {
  const query = createQuery(() => ({
    queryKey: ["posts"],  // Missing userId - always fetches same cache!
    queryFn: () => fetchPosts(props.userId()),
  }))
}
```

```typescript
// ✅ CORRECT: Query key includes all dependencies
function UserPosts(props: { userId: Accessor<string> }) {
  const query = createQuery(() => ({
    queryKey: ["posts", props.userId()],  // Cache is per-user
    queryFn: () => fetchPosts(props.userId()),
  }))
}
```

### Mistake 6: Using Query Data in Effects Without Tracking

```typescript
// ❌ WRONG: Effect doesn't re-run when query.data changes
const query = createQuery(/* ... */)

createEffect(() => {
  // This captures query.data once - won't re-run when data updates
  const data = query.data
  if (data) {
    analytics.track("data_loaded", { count: data.length })
  }
})
```

```typescript
// ✅ CORRECT: Access query.data inside the effect body
const query = createQuery(/* ... */)

createEffect(() => {
  // Accessing query.data here creates a reactive dependency
  if (query.data) {
    analytics.track("data_loaded", { count: query.data.length })
  }
})
```

---

## Quick Reference

| React Query | Solid Query |
|-------------|-------------|
| `useQuery({...})` | `createQuery(() => ({...}))` |
| `const { data } = useQuery(...)` | `const query = createQuery(...); query.data` |
| `useMutation({...})` | `createMutation(() => ({...}))` |
| `useInfiniteQuery({...})` | `createInfiniteQuery(() => ({...}))` |
| `suspense: true` option | Wrap in `<Suspense>` |
| `notifyOnChangeProps` | Not needed - automatic |

## See Also

- [Reactivity Fundamentals](reactivity.md) - Understanding SolidJS reactive tracking
- [Anti-Patterns](anti-patterns.md) - Common mistakes including query-related issues
- [Performance Patterns](performance.md) - Optimizing queries and renders
