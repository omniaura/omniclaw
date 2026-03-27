---
title: Always Validate "use server" Function Inputs
impact: CRITICAL
impactDescription: Security vulnerability — client can send any data across RPC boundary
tags: solidstart, use-server, validation, security, server-functions
---

## Always Validate "use server" Function Inputs

**Impact: CRITICAL (security vulnerability — client can send any data across RPC boundary)**

`"use server"` functions are called via RPC from the client. TypeScript types don't exist at runtime — the client can send anything. Always validate inputs server-side.

**Incorrect (trusting TypeScript types across RPC boundary):**

```typescript
async function updateUser(email: string, name: string) {
  "use server"
  // email might not be a string! Could be an object, null, or malicious input
  await db.users.update({ email, name })
}
```

**Correct (validate all inputs server-side):**

```typescript
import { z } from "zod"

const UpdateUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(100),
})

async function updateUser(input: unknown) {
  "use server"
  const { email, name } = UpdateUserSchema.parse(input)
  await db.users.update({ email, name })
}
```

**Also**: Never leak error stacks to the client. Throw serializable error objects:

```typescript
async function createPost(input: unknown) {
  "use server"
  try {
    const data = PostSchema.parse(input)
    return await db.posts.create(data)
  } catch (e) {
    throw { message: "Failed to create post", code: "CREATE_FAILED" }
  }
}
```

Reference: [SolidStart "use server"](https://docs.solidjs.com/solid-start/reference/server/use-server)
