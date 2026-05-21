# Workflow Template Seeds

These JSON files are development/bootstrap examples only.

Runtime workflow templates are owned by the database (`workflow_templates`) and
managed through `/api/config/workflows`. The server must not import or upsert
these files during normal startup, because client and campaign workflows need to
remain DB-owned.
