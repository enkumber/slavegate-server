# SQL Bind Dynamic Inventory

Story: STORY-PN-POST-3-9-312-DEFECT-CLASS-CONSOLIDATION-AUDIT-001
HEAD: ff08a27eab689b8ca02075b8dc0d5370565ade7e
Records: 95
Method: TypeScript compiler API with PostgreSQL placeholder lexing over static template spans.

## Scope

This artifact inventories the 95 unresolved dynamic PostgreSQL template query callsites from the prior AST lane. The eight incident daily-audit dynamic templates handled by the P0 incident lane are excluded from this unresolved P1 set.

## Defect-Class Findings

- dyn-sql-059 src/modules/ops-monitor/ops-monitor.service.ts:196 defect: scalar value is interpolated into SQL text; parameterize before remediation claim
- dyn-sql-060 src/modules/ops-monitor/ops-monitor.service.ts:285 defect: scalar value is interpolated into SQL text; parameterize before remediation claim
- dyn-sql-061 src/modules/ops-monitor/ops-monitor.service.ts:333 defect: scalar value is interpolated into SQL text; parameterize before remediation claim

## Validation

`reports/post-3.9.312-defect-class-consolidation/inventory/sql-bind.json` validates as JSON and contains exactly 95 records.
