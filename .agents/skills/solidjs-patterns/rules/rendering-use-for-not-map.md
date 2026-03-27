---
title: Use <For> Instead of .map() for Lists
impact: CRITICAL
impactDescription: 100-1000× more DOM operations — full remount on every update
tags: rendering, for, map, lists, performance, migration
---

## Use `<For>` Instead of .map() for Lists

**Impact: CRITICAL (100-1000× more DOM operations — full remount on every update)**

`.map()` works but recreates every DOM node when the list changes. `<For>` diffs by reference and only mounts new items. For lists that grow incrementally (chat, feeds), `.map()` causes catastrophic remounts.

**Incorrect (.map() — ALL items remount on every change):**

```typescript
{messages().map(message => (
  <ChatMessage key={message.id} data={message} />
)).reverse()}
// Symptoms: avatar images flash/reload, scroll position jumps,
// thousands of mounts for what should be incremental updates
```

**Correct (<For> — only new items mount):**

```typescript
const reversedMessages = createMemo(() => [...messages()].reverse())

<For each={reversedMessages()}>
  {(message) => (
    <ChatMessage data={message} />
  )}
</For>
```

**Real-world impact**: For a chat with pagination, `.map()` caused 6,000+ remounts instead of 10. Users saw avatars refreshing and scroll jumping.

Reference: [SolidJS `<For>` Component](https://docs.solidjs.com/reference/components/for)
