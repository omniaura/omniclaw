---
title: Choose Between For and Index Based on What Changes
impact: MEDIUM
impactDescription: "unnecessary re-renders in dynamic lists"
tags: For, Index, indexArray, mapArray, lists
---

## Choose Between For and Index Based on What Changes

**Impact: MEDIUM (unnecessary re-renders in dynamic lists)**

SolidJS provides two list rendering strategies. `<For>` (backed by `mapArray`) keys items by reference — efficient when items are added/removed but order is mostly stable. `<Index>` (backed by `indexArray`) keys items by index — efficient when item values change but the array length stays the same. Choosing the wrong one causes unnecessary DOM updates.

**Incorrect (For used for a fixed-length array with changing values):**

```typescript
// Bad: items change in place (e.g., live scores updating) but array length is fixed
// <For> sees every item as "removed + re-added" because references change
<For each={liveScores()}>
  {(score) => <ScoreCard value={score} />}  {/* All cards remount on every update */}
</For>
```

**Correct (Index for fixed-length arrays with changing values):**

```typescript
import { Index } from "solid-js"

// Items keyed by position — only changed values re-render
<Index each={liveScores()}>
  {(score, index) => <ScoreCard value={score()} position={index} />}
</Index>
```

**Correct (For for dynamic-length arrays with stable items):**

```typescript
import { For } from "solid-js"

// Items keyed by reference — additions/removals are efficient
<For each={chatMessages()}>
  {(message) => <ChatMessage data={message} />}
</For>
```

**Notes:**
- `<For>`: item is a plain value, index is a signal. Use when items are objects with identity (chat messages, users, todos)
- `<Index>`: item is a signal, index is a plain number. Use when items are primitives that update in place (scores, sensor readings, pixel grids)
- Rule of thumb: if you would use a `key` prop in React, use `<For>`; if items are positional, use `<Index>`
- For most UI lists (todos, users, messages), `<For>` is the right default

Reference: [SolidJS Index docs](https://docs.solidjs.com/reference/components/index-component)
