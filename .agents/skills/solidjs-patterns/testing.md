# Testing SolidJS Code

Guide to unit testing SolidJS components and hooks with vitest.

## Setup

The project uses:
- `vitest` - Test runner
- `@solidjs/testing-library` - Component testing utilities
- `vite-plugin-solid` - Ensures browser build of solid-js is used

## Testing Reactive State Logic

For testing state management patterns without full component rendering:

```typescript
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { describe, expect, it } from "vitest"

describe("Collapsible State", () => {
  function createCollapsibleState() {
    const [expanded, setExpanded] = createStore<boolean[]>([])
    const toggle = (index: number) => setExpanded(index, prev => !prev)
    return { expanded, toggle }
  }

  it("toggles items independently", () => {
    // createRoot provides a reactive context for testing
    createRoot(dispose => {
      const { expanded, toggle } = createCollapsibleState()

      expect(expanded[0]).toBe(undefined) // or false

      toggle(0)
      expect(expanded[0]).toBe(true)

      toggle(1)
      expect(expanded[0]).toBe(true)  // unchanged
      expect(expanded[1]).toBe(true)

      toggle(0)
      expect(expanded[0]).toBe(false) // toggled back
      expect(expanded[1]).toBe(true)  // unchanged

      dispose() // Clean up reactive context
    })
  })
})
```

## Testing Hooks with renderHook

```typescript
import { renderHook } from "@solidjs/testing-library"
import { describe, expect, it } from "vitest"
import { useCounter } from "./useCounter"

describe("useCounter", () => {
  it("increments counter", () => {
    const { result } = renderHook(() => useCounter())

    expect(result.count()).toBe(0)

    result.increment()

    expect(result.count()).toBe(1)
  })
})
```

## Testing Components

```typescript
import { render, screen, fireEvent } from "@solidjs/testing-library"
import { describe, expect, it } from "vitest"
import { Counter } from "./Counter"

describe("Counter", () => {
  it("increments on click", async () => {
    render(() => <Counter />)

    const button = screen.getByRole("button")
    expect(screen.getByText("Count: 0")).toBeInTheDocument()

    fireEvent.click(button)

    expect(screen.getByText("Count: 1")).toBeInTheDocument()
  })
})
```

## Mocking Dependencies

Use `vi.mock` with `vi.hoisted` for proper mock hoisting:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest"

// Hoisted mocks run before vi.mock
const { mocks } = vi.hoisted(() => ({
  mocks: {
    fetchUser: vi.fn(() => Promise.resolve({ id: "1", name: "Test" })),
    useAuth: vi.fn(() => ({ user: () => ({ uid: "test-123" }) }))
  }
}))

vi.mock("@/api/users", () => ({
  fetchUser: mocks.fetchUser
}))

vi.mock("@/hooks/useAuth", () => ({
  useAuth: mocks.useAuth
}))

describe("UserProfile", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("fetches user data", async () => {
    // Test implementation
  })
})
```

## Testing Async Code

For resources and async effects:

```typescript
import { render, screen, waitFor } from "@solidjs/testing-library"

it("loads data asynchronously", async () => {
  render(() => <AsyncComponent />)

  // Wait for loading to complete
  await waitFor(() => {
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument()
  })

  expect(screen.getByText("Data loaded")).toBeInTheDocument()
})
```

## Testing Effects

Effects run synchronously in SolidJS during the first render:

```typescript
import { createRoot, createSignal, createEffect } from "solid-js"

it("effect runs on signal change", () => {
  createRoot(dispose => {
    const [count, setCount] = createSignal(0)
    const effectCalls: number[] = []

    createEffect(() => {
      effectCalls.push(count())
    })

    expect(effectCalls).toEqual([0]) // Effect ran once

    setCount(1)
    expect(effectCalls).toEqual([0, 1]) // Effect ran again

    dispose()
  })
})
```

## File Naming Convention

Test files should be named `*.test.ts` or `*.test.tsx`:

```
src/
├── components/
│   ├── Counter.tsx
│   └── Counter.test.tsx
├── hooks/
│   ├── useCounter.ts
│   └── useCounter.test.tsx
└── lib/
    ├── utils.ts
    └── utils.test.ts
```

## Running Tests

```bash
# Run all tests
bun run test

# Run specific test file
bun run test src/components/Counter.test.tsx

# Run tests in watch mode
bun run test --watch

# Run with coverage
bun run test --coverage
```

## Documentation Tests

For documenting patterns without actual assertions:

```typescript
describe("Pattern Documentation", () => {
  it("documents: correct way to handle X", () => {
    // This test serves as documentation
    // The pattern shown here is the recommended approach:
    //
    // const [state, setState] = createStore<T[]>([])
    // setState(index, value)
    //
    // This provides fine-grained reactivity...

    expect(true).toBe(true) // Placeholder assertion
  })
})
```
