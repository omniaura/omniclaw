# Sections

This file defines all sections, their ordering, impact levels, and descriptions.
The section ID (in parentheses) is the filename prefix used to group rules.

---

## 1. Reactivity Correctness (reactivity)

**Impact:** CRITICAL
**Description:** SolidJS's fine-grained reactivity is its core advantage but also the #1 source of bugs. Signals must be read inside reactive contexts, stores must not be destructured, and tracking scopes must be understood. Getting reactivity wrong silently breaks your UI.

## 2. Data Fetching & Server (data)

**Impact:** CRITICAL
**Description:** Correct data fetching patterns (createAsync, query, createResource, Solid Query) prevent waterfalls, avoid Suspense traps, and keep UIs responsive. SolidStart server functions ("use server") require input validation at the boundary.

## 3. Component Patterns (component)

**Impact:** HIGH
**Description:** Props handling (splitProps, mergeProps), children patterns, and component composition are unique in SolidJS. Destructuring breaks reactivity, rest spread loses tracking, and component functions run once (not per-render like React).

## 4. State Management (state)

**Impact:** HIGH
**Description:** Choosing the right primitive (signal vs store vs context) determines update granularity. Stores provide per-property reactivity for objects/arrays. Incorrect choices cause either over-updating (signal for collections) or unnecessary complexity (store for primitives).

## 5. Rendering & Control Flow (rendering)

**Impact:** MEDIUM-HIGH
**Description:** SolidJS control flow components (Show, For, Switch, Index, ErrorBoundary) are not syntactic sugar — they're performance-critical. Using JSX conditionals or .map() instead causes full remounts and lost state.

## 6. SolidStart Patterns (start)

**Impact:** MEDIUM-HIGH
**Description:** SolidStart-specific patterns for routing, server functions, middleware, SSR, and deployment. Includes createAsync + query patterns, "use server" validation, and file-based routing best practices.

## 7. Performance Optimization (perf)

**Impact:** MEDIUM
**Description:** Code splitting, lazy loading, bundle optimization, memoization, and Suspense boundary placement. SolidJS is fast by default, but lazy loading and strategic Suspense boundaries still matter for large apps.

## 8. Testing (testing)

**Impact:** LOW-MEDIUM
**Description:** Testing reactive code requires understanding createRoot, renderHook, and how effects run synchronously in test contexts. Solid Query mocking and async testing have unique patterns.

## 9. External Interop (interop)

**Impact:** LOW
**Description:** Bridging SolidJS reactivity with external APIs (browser observers, RxJS, WebSockets) via `from` and `observable`. Advanced patterns for when you need to consume or expose signals to non-Solid code.
