---
title: Use createReaction to Separate Tracking from Side Effects
impact: LOW
tags: reactivity, advanced, tracking
---

## Use createReaction to Separate Tracking from Side Effects

**Impact: LOW (fine-grained control over effect triggers)**

`createReaction` separates what you track from what happens when it changes. The tracking function defines dependencies; the reaction function runs when they change. Useful when you want to observe only specific properties of a complex signal.

**Incorrect (effect tracks more dependencies than needed):**

```typescript
createEffect(() => {
  // Tracks ALL properties of user() — re-runs on any change
  console.log("User ID changed:", user().id)
})
```

**Correct (track only what matters):**

```typescript
import { createReaction } from "solid-js"

const track = createReaction(() => {
  console.log("User ID changed:", user().id)
})

// Only re-runs when user().id changes, not on other user property changes
track(() => user().id)
```

**Notes:**
- The tracking function (passed to `track()`) defines which signals to observe
- The reaction function (passed to `createReaction()`) runs when tracked signals change
- Useful for preventing unnecessary effect re-runs on complex objects
