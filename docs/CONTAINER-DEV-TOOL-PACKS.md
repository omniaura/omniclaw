# Container Dev Tool Packs

## Why this exists

OmniClaw agents currently share one container image. That keeps operations simple, but it creates two problems:

- Agents that need language toolchains (Rust, Go, etc.) often install them at runtime, increasing boot latency and variability.
- As more teams use OmniClaw for different workloads, a one-size-fits-all image either grows too large or remains underpowered.

Issue #191 starts by adding Rust (`cargo`/`rustc`) to the base image and defines a path toward configurable toolchains.

## Current baseline (Mar 2026)

- Shared base image includes Bun, Node/npm, Go, GitHub CLI, Graphite CLI, and agent-browser.
- Rust (`cargo` and `rustc`) is now included in base image for immediate productivity.
- Browser tooling stays in the shared base image for now because it is broadly useful across agents.
- Container startup remains deterministic (no runtime language bootstrap required for Go/Rust workflows).

## Design goals

- Keep default setup fast for new users.
- Allow per-agent toolchain customization without ad-hoc runtime installs.
- Avoid combinatorial image explosion.
- Preserve reproducibility and security (pinned versions where practical, explicit install paths).

## Proposed model

Use a layered, build-time pack system with a small set of curated packs.

1. Keep a stable `base` image with core utilities.
2. Define pack install modules (for example `rust`, `go`, `web`) as build fragments.
3. Let each agent group declare required packs in config.
4. Build or reuse a cached image keyed by pack set (sorted deterministic key).

This combines predictable build output with flexible composition, while avoiding bespoke Dockerfiles per agent.

## Pack declaration

Proposed channel/group config shape:

```yaml
container:
  toolPacks:
    - rust
    - web
```

Rules:

- Unknown packs fail validation early.
- Pack names are normalized and deduplicated.
- Pack order does not affect cache key.

## Build strategy

### Phase 1 (now)

- Keep one shared base image and include commonly needed tools (browser + Go + Rust).
- No behavior change in container runner.

### Phase 2

- Add pack definitions under `container/packs/`.
- Add a small build orchestrator that generates or selects image variants by pack key.
- Let each agent select an LLM model and a canonical dev tool pack independently.
- Support repo-shipped Dockerfile templates so advanced users can derive custom variants without forking the runtime.
- Cache built images locally to avoid repeated rebuilds.

### Phase 3

- Add eviction policy and observability (image size, build duration, hit rate).
- Consider remote prebuilds for common pack combinations if needed.

## Scope boundaries

- Packs are for language/runtime toolchains and related build tools.
- App-specific dependencies stay in project repositories.
- Keep official pack catalog intentionally small; avoid every-language-by-default sprawl.

## Risks and mitigations

- Image size growth: track size deltas per pack and enforce review threshold.
- Build complexity: centralize pack schema and deterministic key generation.
- Security drift: pin versions for externally downloaded binaries and keep update cadence.

## Open questions

- Should model choice and tool pack choice both live on the existing agent record?
- Should we expose pack config globally per channel, per agent, or both?
- Should `full` be a first-class pack alias (`go + rust + web`) for convenience?
- Should pack images be prebuilt in CI or built lazily on first use?
