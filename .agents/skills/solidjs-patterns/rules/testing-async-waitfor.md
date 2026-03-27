---
title: Use waitFor for Async Component Assertions
impact: LOW
impactDescription: "flaky tests from timing-dependent assertions"
tags: testing, async, waitFor, Suspense
---

## Use waitFor for Async Component Assertions

**Impact: LOW (flaky tests from timing-dependent assertions)**

When testing components that load data asynchronously (via `createResource`, `createAsync`, or Solid Query), use `waitFor` from `@solidjs/testing-library` to wait for the loading state to resolve. Direct assertions on async content fail because the data is not yet available when the assertion runs.

**Incorrect (asserting before async content loads):**

```typescript
import { render, screen } from "@solidjs/testing-library"

it("shows user data", () => {
  render(() => <UserProfile userId="123" />)

  // Fails — component is still showing loading fallback
  expect(screen.getByText("John Doe")).toBeInTheDocument()
})
```

**Correct (waitFor polls until assertion passes):**

```typescript
import { render, screen, waitFor } from "@solidjs/testing-library"

it("shows user data", async () => {
  render(() => <UserProfile userId="123" />)

  // Wait for loading to finish
  await waitFor(() => {
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument()
  })

  expect(screen.getByText("John Doe")).toBeInTheDocument()
})
```

**Notes:**
- `waitFor` retries the assertion function on a short interval until it passes or times out
- Always `await` the `waitFor` call — forgetting `await` causes the test to pass vacuously
- For simpler cases, `findByText` combines query + waitFor: `await screen.findByText("John Doe")`
- Set a custom timeout if your async operation is slow: `waitFor(fn, { timeout: 5000 })`

Reference: [Solid Testing Library docs](https://github.com/solidjs/solid-testing-library)
