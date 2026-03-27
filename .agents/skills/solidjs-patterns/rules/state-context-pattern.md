---
title: Use Typed Context with Store for Global State
impact: MEDIUM
impactDescription: Type-safe global state with fine-grained reactivity
tags: state, context, store, global, provider
---

## Use Typed Context with Store for Global State

**Impact: MEDIUM (type-safe global state with fine-grained reactivity)**

Combine `createContext`, `createStore`, and a typed hook for app-wide state. Use getters on the context value to maintain reactivity through the provider boundary.

**Correct pattern:**

```typescript
import { createContext, useContext, ParentComponent } from "solid-js"
import { createStore } from "solid-js/store"

type ThemeStore = {
  theme: "light" | "dark"
  toggleTheme: () => void
}

const ThemeContext = createContext<ThemeStore>()

export const ThemeProvider: ParentComponent = (props) => {
  const [state, setState] = createStore({ theme: "light" as const })

  const store: ThemeStore = {
    get theme() { return state.theme },  // Getter maintains reactivity
    toggleTheme: () => setState("theme", t => t === "light" ? "dark" : "light")
  }

  return (
    <ThemeContext.Provider value={store}>
      {props.children}
    </ThemeContext.Provider>
  )
}

export const useTheme = () => {
  const context = useContext(ThemeContext)
  if (!context) throw new Error("useTheme must be used within ThemeProvider")
  return context
}
```

**Key**: Use `get theme()` (getter), not `theme: state.theme` (captured once).

Reference: [SolidJS Context](https://docs.solidjs.com/concepts/context)
