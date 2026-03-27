# SolidJS State Management Patterns

## Pattern 1: Collapsible/Expandable Lists

When you have a list where each item can be independently expanded/collapsed:

```typescript
import { createStore } from "solid-js/store"
import { For } from "solid-js"

function CollapsibleList() {
  // ✅ Use boolean array for fine-grained reactivity per index
  const [expanded, setExpanded] = createStore<boolean[]>([])

  const toggle = (index: number) => {
    setExpanded(index, prev => !prev)
  }

  return (
    <For each={items()}>
      {(item, index) => (
        <div>
          <button onClick={() => toggle(index())}>
            {expanded[index()] ? "Collapse" : "Expand"}
          </button>
          <Show when={expanded[index()]}>
            <div>{item.content}</div>
          </Show>
        </div>
      )}
    </For>
  )
}
```

### Why This Works

- `createStore<boolean[]>` creates a proxy that tracks each index separately
- `expanded[index()]` in JSX creates a subscription for that specific index
- When `setExpanded(2, true)` is called, only components reading `expanded[2]` update

## Pattern 2: Selection State

For single-selection (one active item at a time):

```typescript
import { createSignal } from "solid-js"

function SelectableList() {
  const [selectedId, setSelectedId] = createSignal<string | null>(null)

  return (
    <For each={items()}>
      {(item) => (
        <div
          classList={{ selected: selectedId() === item.id }}
          onClick={() => setSelectedId(item.id)}
        >
          {item.name}
        </div>
      )}
    </For>
  )
}
```

For multi-selection with fine-grained updates, use `createStore`:

```typescript
const [selected, setSelected] = createStore<Record<string, boolean>>({})

const toggleSelection = (id: string) => {
  setSelected(id, prev => !prev)
}

// In JSX
classList={{ selected: selected[item.id] }}
```

## Pattern 3: Form State

For forms with multiple fields:

```typescript
import { createStore } from "solid-js/store"

function ContactForm() {
  const [form, setForm] = createStore({
    name: "",
    email: "",
    message: ""
  })

  return (
    <form>
      <input
        value={form.name}
        onInput={(e) => setForm("name", e.currentTarget.value)}
      />
      <input
        value={form.email}
        onInput={(e) => setForm("email", e.currentTarget.value)}
      />
      <textarea
        value={form.message}
        onInput={(e) => setForm("message", e.currentTarget.value)}
      />
    </form>
  )
}
```

## Pattern 4: Async State with Resources

For data fetching:

```typescript
import { createResource, Show, Suspense } from "solid-js"

function UserProfile(props: { userId: string }) {
  const [user] = createResource(
    () => props.userId,
    async (id) => fetchUser(id)
  )

  return (
    <Suspense fallback={<Loading />}>
      <Show when={user()}>
        {(userData) => <Profile user={userData()} />}
      </Show>
    </Suspense>
  )
}
```

## Pattern 5: Context for Global State

```typescript
import { createContext, useContext, ParentComponent } from "solid-js"
import { createStore } from "solid-js/store"

type ThemeStore = {
  theme: "light" | "dark"
  toggleTheme: () => void
}

const ThemeContext = createContext<ThemeStore>()

export const ThemeProvider: ParentComponent = (props) => {
  const [state, setState] = createStore({ theme: "light" as const })

  const store: ThemeStore = {
    get theme() { return state.theme },
    toggleTheme: () => setState("theme", t => t === "light" ? "dark" : "light")
  }

  return (
    <ThemeContext.Provider value={store}>
      {props.children}
    </ThemeContext.Provider>
  )
}

export const useTheme = () => {
  const context = useContext(ThemeContext)
  if (!context) throw new Error("useTheme must be used within ThemeProvider")
  return context
}
```

## Pattern 6: Derived State with Memos

```typescript
const [items, setItems] = createSignal<Item[]>([])
const [filter, setFilter] = createSignal("")

// Derived state - automatically updates when items or filter changes
const filteredItems = createMemo(() =>
  items().filter(item =>
    item.name.toLowerCase().includes(filter().toLowerCase())
  )
)

const itemCount = createMemo(() => filteredItems().length)
```

## Pattern 7: Data Fetching with Solid Query

For API data fetching with caching and refetching:

```typescript
import { createQuery } from "@tanstack/solid-query"

function UserProfile(props: { userId: string }) {
  const userQuery = createQuery(() => ({
    queryKey: ["user", props.userId],
    queryFn: () => fetchUser(props.userId),
    staleTime: 5 * 60 * 1000, // 5 minutes
  }))

  return (
    <Switch>
      <Match when={userQuery.isLoading}>
        <Skeleton />
      </Match>
      <Match when={userQuery.error}>
        <ErrorDisplay error={userQuery.error} />
      </Match>
      <Match when={userQuery.data}>
        {(user) => <ProfileCard user={user()} />}
      </Match>
    </Switch>
  )
}
```

### Mutation Pattern

```typescript
import { createMutation, useQueryClient } from "@tanstack/solid-query"

function UpdateButton(props: { userId: string }) {
  const queryClient = useQueryClient()

  const mutation = createMutation(() => ({
    mutationFn: (data: UserUpdate) => updateUser(props.userId, data),
    onSuccess: () => {
      // Invalidate and refetch
      queryClient.invalidateQueries({ queryKey: ["user", props.userId] })
    },
  }))

  return (
    <button
      onClick={() => mutation.mutate({ name: "New Name" })}
      disabled={mutation.isPending}
    >
      {mutation.isPending ? "Saving..." : "Save"}
    </button>
  )
}
```

## Pattern 8: Prop Handling with splitProps

Use `splitProps` to separate props for forwarding:

```typescript
import { splitProps, type JSX } from "solid-js"

interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary"
  loading?: boolean
}

function Button(props: ButtonProps) {
  // Split our custom props from native button props
  const [local, buttonProps] = splitProps(props, ["variant", "loading"])

  return (
    <button
      {...buttonProps}
      class={cn(
        "btn",
        local.variant === "primary" && "btn-primary",
        local.loading && "btn-loading"
      )}
      disabled={local.loading || buttonProps.disabled}
    >
      {local.loading ? <Spinner /> : props.children}
    </button>
  )
}
```

### Why splitProps Instead of Destructuring

```typescript
// ❌ BAD: Destructuring loses reactivity
function Button({ variant, loading, ...rest }) {
  // variant and loading won't update if props change!
  return <button {...rest} />
}

// ✅ GOOD: splitProps maintains reactivity
function Button(props) {
  const [local, rest] = splitProps(props, ["variant", "loading"])
  // local.variant and local.loading stay reactive
  return <button {...rest} />
}
```

## When NOT to Use createStore

Use `createSignal` when:

- The value is a primitive (string, number, boolean)
- The object is replaced entirely, not partially updated
- You don't need per-property reactivity

```typescript
// ✅ Good use of createSignal - simple object replaced entirely
const [position, setPosition] = createSignal({ x: 0, y: 0 })
setPosition({ x: 10, y: 20 }) // Replaces entire object

// ✅ Good use of createSignal - primitive
const [isOpen, setIsOpen] = createSignal(false)
```
