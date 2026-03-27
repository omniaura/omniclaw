---
name: solidjs-patterns
description: SolidJS and SolidStart performance and correctness guidelines for AI agents. This skill should be used when writing, reviewing, or refactoring SolidJS/SolidStart code to ensure correct reactivity patterns and optimal performance. Triggers on tasks involving SolidJS components, signals, stores, Solid Query, SolidStart server functions, routing, or fine-grained reactivity.
license: MIT
metadata:
  author: omniaura
  version: "2.1.0"
---

# SolidJS Patterns and Best Practices

Comprehensive correctness and performance guide for SolidJS and SolidStart applications, maintained by OmniAura. Contains 49 rules across 9 categories, prioritized by impact to guide automated refactoring and code generation. Built from production experience migrating from React to SolidJS.

## When to Apply

Reference these guidelines when:
- Writing new SolidJS components or SolidStart pages
- Migrating React code to SolidJS
- Implementing data fetching (Solid Query, createAsync, createResource)
- Working with SolidStart server functions ("use server")
- Reviewing code for reactivity correctness issues
- Optimizing bundle size or rendering performance
- Setting up state management (signals, stores, context)
- Writing tests for reactive code

## Rule Categories by Priority

| Priority | Category | Impact | Prefix |
|----------|----------|--------|--------|
| 1 | Reactivity Correctness | CRITICAL | `reactivity-` |
| 2 | Data Fetching & Server | CRITICAL | `data-` |
| 3 | Component Patterns | HIGH | `component-` |
| 4 | State Management | HIGH | `state-` |
| 5 | Rendering & Control Flow | MEDIUM-HIGH | `rendering-` |
| 6 | SolidStart Patterns | MEDIUM-HIGH | `start-` |
| 7 | Performance Optimization | MEDIUM | `perf-` |
| 8 | Testing | LOW-MEDIUM | `testing-` |
| 9 | External Interop | LOW | `interop-` |

## Quick Reference

### 1. Reactivity Correctness (CRITICAL)

- `reactivity-no-destructure-props` - Never destructure props — breaks reactivity
- `reactivity-no-helper-access` - Access signals/stores directly in JSX, not via helpers
- `reactivity-no-set-map-signal` - Use store instead of Set/Map with signal for collections
- `reactivity-no-rest-spread` - Use splitProps instead of rest spread
- `reactivity-signals-not-refs` - Use signals for timing-sensitive state, not plain refs
- `reactivity-no-direct-mutation` - Never mutate store values directly
- `reactivity-no-effect-order` - Don't assume effect execution order
- `reactivity-cleanup-effects` - Always clean up effects with onCleanup
- `reactivity-on-explicit-tracking` - Use on() to break circular dependencies
- `reactivity-create-deferred` - Use createDeferred for expensive computations on rapid input
- `reactivity-create-reaction` - Use createReaction to separate tracking from side effects
- `reactivity-no-signal-capture` - Don't capture signals in closures outside reactive context

### 2. Data Fetching & Server (CRITICAL)

- `data-no-destructure-query` - Never destructure Solid Query results
- `data-parallel-queries` - Don't create query waterfalls
- `data-guard-suspense` - Guard .data access to prevent unwanted Suspense
- `data-include-all-query-keys` - Include all dependencies in query keys
- `data-query-options-function` - Wrap query options in arrow function
- `data-mutation-invalidation` - Invalidate queries after mutations

### 3. Component Patterns (HIGH)

- `component-no-early-return` - Don't return early before reactive primitives
- `component-merge-props` - Use mergeProps for reactive default values
- `component-split-props` - Use splitProps to separate and forward props

### 4. State Management (HIGH)

- `state-signal-vs-store` - Choose signal vs store based on update granularity
- `state-context-pattern` - Use typed context with store for global state
- `state-reconcile-async` - Use reconcile for fine-grained async updates
- `state-produce-complex-mutations` - Use produce() for complex store mutations
- `state-form-store` - Use createStore for multi-field form state

### 5. Rendering & Control Flow (MEDIUM-HIGH)

- `rendering-use-for-not-map` - Use `<For>` instead of .map() for lists
- `rendering-use-show-not-ternary` - Use `<Show>` instead of JSX conditionals
- `rendering-suspense-inside-show` - Place Suspense inside conditionals (LazyShow pattern)
- `rendering-use-switch-match` - Use Switch/Match for multi-branch conditionals
- `rendering-error-boundary` - Wrap risky components in ErrorBoundary
- `rendering-index-vs-for` - Choose between For and Index based on what changes

### 6. SolidStart Patterns (MEDIUM-HIGH)

- `start-use-server-validation` - Always validate "use server" function inputs
- `start-createasync-not-resource` - Use createAsync + query() for data loading
- `start-route-preloading` - Always define route preload functions

### 7. Performance Optimization (MEDIUM)

- `perf-lazy-load-heavy-components` - Lazy load heavy components
- `perf-create-selector` - Use createSelector for single-selection in large lists
- `perf-memo-expensive` - Use createMemo for expensive derived computations
- `perf-route-code-splitting` - Use lazy() for route-level code splitting
- `perf-skeleton-suspense` - Use skeleton components for Suspense fallbacks
- `perf-use-transition` - Use useTransition for non-blocking async updates
- `perf-render-effect` - Use createRenderEffect for synchronous DOM measurements

### 8. Testing (LOW-MEDIUM)

- `testing-createroot` - Wrap reactive test code in createRoot
- `testing-render-components` - Use render() and Testing Library for component tests
- `testing-render-hook` - Use renderHook for testing custom hooks
- `testing-async-waitfor` - Use waitFor for async component testing
- `testing-mock-hoisted` - Use vi.hoisted with vi.mock for proper mock hoisting

### 9. External Interop (LOW)

- `interop-from-browser-apis` - Use from() to bridge browser APIs into reactive signals
- `interop-observable-export` - Use observable() to expose signals to external libraries

## How to Use

Read individual rule files for detailed explanations and code examples:

```
rules/reactivity-no-destructure-props.md
rules/data-parallel-queries.md
rules/start-use-server-validation.md
```

Each rule file contains:
- Brief explanation of why it matters
- Incorrect code example with explanation
- Correct code example with explanation
- Impact rating and tags
- Additional context and references

## Full Compiled Document

For the complete guide with all rules expanded: `AGENTS.md`

## Legacy Files

The following files contain additional detailed patterns and are being migrated into individual rules:
- `reactivity.md` - Reactivity fundamentals
- `explicit-tracking.md` - on() and untrack() patterns
- `state-patterns.md` - State management patterns
- `anti-patterns.md` - Common anti-patterns
- `advanced-primitives.md` - Secondary primitives
- `external-interop.md` - from() and observable() patterns
- `solid-query.md` - Solid Query patterns
- `performance.md` - Performance optimization
- `testing.md` - Testing patterns
