# UI Graph Runtime

Phone Network executes Android workflows through one guarded fast/slow path:

`State Resolver -> Graph Policy -> Selector Resolver -> guarded coordinates -> OCR -> VLM -> verification -> candidate learning -> promotion`

## Runtime modes

- `disabled`: global kill switch; the legacy executor remains authoritative.
- `shadow`: resolves states and targets, records observations and candidates, but the legacy executor still acts.
- `enforced`: selector-first targeting and promoted graph recovery are authoritative for the selected scope.

The container defaults to `shadow`. Database flags can narrow or promote `global`, `app`, `workflow`, and `device` scopes, but cannot override a startup mode of `disabled`.

Environment flags:

- `UI_GRAPH_RUNTIME_MODE=disabled|shadow|enforced`
- `UI_GRAPH_SELECTOR_FIRST=true|false`
- `UI_GRAPH_GRAPH_RUNTIME=true|false`
- `UI_GRAPH_AI_RECOVERY=true|false`
- `UI_GRAPH_CANDIDATE_LEARNING=true|false`
- `UI_GRAPH_AUTO_PROMOTION=true|false`

Automatic promotion is off by default.

## State and target policy

State matching tries exact fingerprints, required/optional/forbidden anchors, and weighted fuzzy matching. Ambiguous matches return `unknown`; mutating execution never guesses a state.

Target resolution order is:

1. exact `resource-id`;
2. exact `content-description`;
3. semantic ID;
4. exact text, then controlled partial text;
5. structural selector;
6. normalized coordinate only when state variant, app version and device context match;
7. OCR;
8. VLM.

Only `promoted` selectors and transitions are eligible for the enforced fast path. Dynamic elements never persist coordinate knowledge.

## Learning lifecycle

Discoveries move through:

`candidate -> validating -> promoted -> degraded -> quarantined|retired`

A11y selectors require at least three verified successes in two contexts. OCR, VLM and LLM recovery knowledge require at least five. Mutating or sensitive knowledge always requires manual review. Promotion and quarantine are audited in `ui_graph_promotion_events`.

## Operations

The dashboard's **UI Graph** page exposes 24-hour fast-path/VLM/unknown-state KPIs, scoped rollout flags, candidate review and App Map materialization.

Recommended rollout:

1. keep global shadow mode until representative telemetry exists;
2. enforce a read-only workflow on one canary device;
3. enforce navigation for one app;
4. promote low-risk mutating workflows only after replay and device gates;
5. expand by cohort while retaining the environment kill switch.

Rollback is a flag change to `disabled` for the affected scope, or `UI_GRAPH_RUNTIME_MODE=disabled` for a global startup rollback. The schema and observations are additive and require no reverse migration.
