# SQL Bind Dynamic Inventory

Story: STORY-PN-POST-3-9-312-DEFECT-CLASS-CONSOLIDATION-AUDIT-001
Inventory source HEAD: ff08a27eab689b8ca02075b8dc0d5370565ade7e
Review update HEAD: same commit as this remediation artifact
Records: 95
Reviewed: 95
Method: TypeScript compiler API with PostgreSQL placeholder lexing over static template spans.

## Scope

This artifact inventories and individually reviews the 95 unresolved dynamic PostgreSQL template query callsites from the prior AST lane. The eight incident daily-audit dynamic templates handled by the P0 incident lane are excluded from this unresolved gate-1 set.

## Remediated Findings

- dyn-sql-059 src/modules/ops-monitor/ops-monitor.service.ts:196 remediated: interpolated INTERVAL text now uses `NOW() - ($1::int * INTERVAL '1 hour')` with `[lookbackHours]`.
- dyn-sql-060 src/modules/ops-monitor/ops-monitor.service.ts:285 remediated: interpolated INTERVAL text now uses `NOW() - ($1::int * INTERVAL '1 hour')` with `[lookbackHours]`.
- dyn-sql-061 src/modules/ops-monitor/ops-monitor.service.ts:333 remediated: JSONB string interpolation now uses a `$1::jsonb` bind containing `last_health_check`.

## Validation

`reports/post-3.9.312-defect-class-consolidation/inventory/sql-bind.json` validates as JSON and contains exactly 95 individually reviewed records. The three defect records are marked remediated after the focused ops-monitor SQL binding regression.

Focused regression coverage in `src/modules/ops-monitor/ops-monitor.service.test.ts` records the SQL text and bind arrays for the affected queries, exercises hostile lookback and timestamp values, asserts exact `$1` arity, and confirms the lifecycle predicate remains `lifecycle_state_matches(...)` rather than hardcoded status literals.
