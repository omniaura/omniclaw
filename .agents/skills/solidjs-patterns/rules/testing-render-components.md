---
title: Use render() and Testing Library for Component Tests
impact: MEDIUM
tags: testing, components, testing-library
---

## Use render() and Testing Library for Component Tests

**Impact: MEDIUM (correct component testing prevents false positives)**

Use `@solidjs/testing-library` with `render(() => <Component />)` — note the arrow function wrapper, which is required for SolidJS's rendering model. Query by role and accessible names for resilient tests.

**Incorrect (missing arrow function wrapper):**

```typescript
import { render, screen } from "@solidjs/testing-library"

// ❌ Wrong: passing JSX directly instead of a function
render(<Counter />)
```

**Correct (arrow function wrapper + role-based queries):**

```typescript
import { render, screen, fireEvent } from "@solidjs/testing-library"
import { describe, expect, it } from "vitest"

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

**Notes:**

- Always wrap in `render(() => ...)` — SolidJS components are functions that run once
- Use `renderHook(() => useMyHook())` for testing custom hooks without a component
- For async content, use `waitFor()` to wait for Suspense/resource resolution
- Use `vi.hoisted()` with `vi.mock()` for proper mock hoisting in vitest
