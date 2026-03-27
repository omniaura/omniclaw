---
title: Use <Show> Instead of JSX Conditionals
impact: HIGH
impactDescription: Component state lost, animations restart on condition toggle
tags: rendering, show, conditionals, ternary, migration
---

## Use `<Show>` Instead of JSX Conditionals

**Impact: HIGH (component state lost, animations restart on condition toggle)**

JSX ternary (`? :`) and AND (`&&`) patterns destroy and recreate components on every condition change. `<Show>` preserves component instances and integrates with SolidJS signals for optimal updates.

**Incorrect (JSX conditionals — component destroyed and recreated):**

```typescript
{isLoading() && <Spinner />}

{isLoggedIn() ? <Dashboard /> : <LoginForm />}
// Component state lost, animations restart, expensive effects re-run
```

**Correct (<Show> — component instances preserved):**

```typescript
<Show when={isLoading()}>
  <Spinner />
</Show>

<Show when={isLoggedIn()} fallback={<LoginForm />}>
  <Dashboard />
</Show>
```

Use `Switch`/`Match` for multi-branch conditionals:

```typescript
<Switch fallback={<DefaultView />}>
  <Match when={status() === "loading"}><Loading /></Match>
  <Match when={status() === "error"}><Error /></Match>
  <Match when={status() === "success"}><Success /></Match>
</Switch>
```

Reference: [SolidJS `<Show>` Component](https://docs.solidjs.com/reference/components/show)
