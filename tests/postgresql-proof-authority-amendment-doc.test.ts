import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("PostgreSQL proof authority amendment runbook", () => {
  it("uses executable transactional assertions for repair and rollback safety", () => {
    const doc = readFileSync("docs/postgresql-proof-authority-amendment.md", "utf8");

    expect(doc).toContain("DO $$");
    expect(doc).toContain("LOCK TABLE workflow_compositions IN SHARE ROW EXCLUSIVE MODE");
    expect(doc).toContain("LOCK TABLE resource_runtime_policies IN SHARE ROW EXCLUSIVE MODE");
    expect(doc).toContain("FOR UPDATE");
    expect(doc).toContain("lifecycle_state_matches");
    expect(doc).toContain("'workflow_compositions'::regclass");
    expect(doc).toContain("'lifecycle_status'");
    expect(doc).toContain("RAISE EXCEPTION 'expected exactly one canonical predicate metadata row");
    expect(doc).toContain("RAISE EXCEPTION 'expected exactly one repair target");
    expect(doc).toContain("RAISE EXCEPTION 'expected exactly one admitted replacement proof predicate");
    expect(doc).toContain("RAISE EXCEPTION 'expected exactly one deactivated target");
    expect(doc).toContain("RAISE EXCEPTION 'expected exactly one inserted replacement");
    expect(doc).toContain("RAISE EXCEPTION 'expected exactly one active promoted replacement");
    expect(doc).toContain("legacy composition key % remains promoted");
    expect(doc).toContain("legacy_workflow_predicate_metadata_present()");
    expect(doc).toContain("replacesCompositionKey");
    expect(doc).toContain("PostgreSQL rolls the transaction back");
    expect(doc).toContain("There is no manual inspect-after-commit abort window");
    expect(doc).not.toContain("Abort if the final `SELECT`");
    expect(doc.indexOf("expected exactly one admitted replacement proof predicate"))
      .toBeLessThan(doc.indexOf("UPDATE workflow_compositions"));
  });
});
