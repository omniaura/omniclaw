---
title: Use createStore for Multi-Field Form State
impact: MEDIUM
impactDescription: "over-rendering on every field change"
tags: createStore, forms, state, fine-grained
---

## Use createStore for Multi-Field Form State

**Impact: MEDIUM (over-rendering on every field change)**

For forms with multiple fields, use `createStore` instead of individual signals or a single signal holding an object. A store provides per-property reactivity: typing in the name field only re-renders the name input, not the entire form.

**Incorrect (single signal replaces entire object on every keystroke):**

```typescript
const [form, setForm] = createSignal({ name: "", email: "", message: "" })

// Every field re-renders on ANY field change because the whole object is replaced
<input
  value={form().name}
  onInput={(e) => setForm(prev => ({ ...prev, name: e.currentTarget.value }))}
/>
<input
  value={form().email}
  onInput={(e) => setForm(prev => ({ ...prev, email: e.currentTarget.value }))}
/>
```

**Correct (createStore tracks each field independently):**

```typescript
import { createStore } from "solid-js/store"

const [form, setForm] = createStore({
  name: "",
  email: "",
  message: ""
})

// Only the name input re-renders when name changes
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
```

**Notes:**
- Store property access (`form.name`) creates a subscription to only that property
- The path-based setter (`setForm("name", value)`) updates a single field without replacing the object
- For nested form data (e.g., `address.city`), use nested paths: `setForm("address", "city", value)`
- For simple forms with 1-2 fields, individual `createSignal` calls are fine

Reference: [SolidJS createStore docs](https://docs.solidjs.com/reference/store-utilities/create-store)
