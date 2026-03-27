---
title: Use Specific Component Type Annotations
impact: MEDIUM
impactDescription: "unclear children expectations, weaker type checking"
tags: component, TypeScript, types, children
---

## Use Specific Component Type Annotations

**Impact: MEDIUM (unclear children expectations, weaker type checking)**

SolidJS provides four component type aliases with different `children` constraints. Use the most specific type so consumers know exactly what children are accepted.

**The type hierarchy:**

```typescript
import type { Component, VoidComponent, ParentComponent, FlowComponent } from "solid-js"

// Generic — no children constraint
const Widget: Component<{ label: string }> = (props) => ...

// No children allowed
const Icon: VoidComponent<{ name: string }> = (props) => ...

// Optional JSX.Element children
const Card: ParentComponent<{ title: string }> = (props) => ...

// Required children (often render callbacks)
const Tooltip: FlowComponent<{ text: string }, JSX.Element> = (props) => ...
```

**When to use each:**

| Type | Children | Use For |
|------|----------|---------|
| `VoidComponent<P>` | None | Leaf components: icons, inputs, badges |
| `ParentComponent<P>` | Optional `JSX.Element` | Wrappers: cards, layouts, panels |
| `FlowComponent<P, C>` | Required `C` (default `JSX.Element`) | Control flow: modals, render-prop components |
| `Component<P>` | Unconstrained | When none of the above fit |

**Example — VoidComponent prevents accidental children:**

```typescript
// TypeScript error if someone tries to pass children
const Avatar: VoidComponent<{ src: string; alt: string }> = (props) => (
  <img src={props.src} alt={props.alt} class="avatar" />
)

// TS Error: Property 'children' does not exist
<Avatar src="pic.jpg" alt="User">Some text</Avatar>
```

**Example — FlowComponent for render props:**

```typescript
const Repeat: FlowComponent<{ times: number }, (i: number) => JSX.Element> = (props) => (
  <For each={Array.from({ length: props.times }, (_, i) => i)}>
    {(i) => props.children(i)}
  </For>
)
```

**Notes:**
- Default to `VoidComponent` for leaf components — it catches accidental children at compile time
- `ParentComponent` adds `children?: JSX.Element` to props automatically
- These types are purely for TypeScript — they compile away with zero runtime cost

Reference: [SolidJS Component types](https://docs.solidjs.com/reference/component-apis/component)
