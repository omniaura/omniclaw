---
title: Use vi.hoisted for Mock Definitions
impact: LOW
impactDescription: "mock reference errors or stale mock state"
tags: testing, vitest, mocking, vi.hoisted
---

## Use vi.hoisted for Mock Definitions

**Impact: LOW (mock reference errors or stale mock state)**

When mocking modules in vitest, define mock implementations inside `vi.hoisted` so they are available before `vi.mock` runs. Without hoisting, mock references may be undefined when the mock factory executes, causing confusing errors.

**Incorrect (mock function defined after vi.mock — hoisting issue):**

```typescript
import { vi } from "vitest"

// vi.mock is hoisted to the top of the file at runtime
vi.mock("@/api/users", () => ({
  fetchUser: mockFetchUser  // ReferenceError: mockFetchUser is not defined
}))

// This line runs AFTER vi.mock in source, but vi.mock is hoisted above it
const mockFetchUser = vi.fn()
```

**Correct (vi.hoisted ensures mocks are defined before vi.mock runs):**

```typescript
import { beforeEach, vi } from "vitest"

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

beforeEach(() => {
  vi.clearAllMocks()
})
```

**Notes:**
- `vi.hoisted` runs its callback before any `vi.mock` calls, regardless of source order
- Group related mocks into a single `vi.hoisted` block for clarity
- Always call `vi.clearAllMocks()` in `beforeEach` to reset call counts and return values between tests
- This pattern applies to all vitest projects, not just SolidJS, but is especially common when mocking hooks and API modules

Reference: [Vitest vi.hoisted docs](https://vitest.dev/api/vi.html#vi-hoisted)
