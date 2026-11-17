# Ek Bharat.AI Platform — Planning

Updated 2026-11-16 · Planning documents only. Nothing here is application code. These files move to
the platform repository's `docs/` in work package F0 (decision PD-01).

| Document | Contents |
|---|---|
| [DECISION_REGISTER.md](DECISION_REGISTER.md) | Final decisions PD-01…PD-16, open items, verification tasks |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Modular monolith, module contract, packages, data, AI usage |
| [REPOSITORY_STRUCTURE.md](REPOSITORY_STRUCTURE.md) | Folder layout of `ekbharat-platform` |
| [DEPENDENCY_MAP.md](DEPENDENCY_MAP.md) | Allowed dependencies, module rules, enforcement, ownership |
| [MODULE_REMOVAL_STRATEGY.md](MODULE_REMOVAL_STRATEGY.md) | Disable vs decommission, data on removal, removal-matrix tests |
| [AI_GATEWAY.md](AI_GATEWAY.md) | Universal, model-agnostic AI Gateway: interface, adapters, registry, connections, secrets, routing, fallback, metering, BYOK, contract tests |
| [AI_EVALUATION_FRAMEWORK.md](AI_EVALUATION_FRAMEWORK.md) | Reusable evals: quality, citations, tutoring, latency, cost |
| [FOUNDATION_IMPLEMENTATION.md](FOUNDATION_IMPLEMENTATION.md) | Shared foundation work packages F0–F12 (F6 = F6a–F6d gateway) |

Product plans:
- Tutor (first product): [`modules/education-agents/tutor-agent/`](../modules/education-agents/tutor-agent/README.md) —
  implementation breakdown in its `docs/IMPLEMENTATION_ROADMAP.md`.
- Recruitment (deferred): [`modules/recruitment-agents/`](../modules/recruitment-agents/README.md).

Status: **awaiting product-owner approval before any coding.**
