import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ db: { query: vi.fn() } }));

vi.mock("../../db/client", () => ({ getDb: () => mocks.db }));

import { runOpsMonitor } from "./ops-monitor.service";

describe("ops monitor SQL bindings", () => {
  beforeEach(() => mocks.db.query.mockReset());

  it("binds dynamic scalar values instead of interpolating them into SQL text", async () => {
    mocks.db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await runOpsMonitor({ lookback_hours: 6 });

    const [uiSql, uiParams] = mocks.db.query.mock.calls[0];
    expect(String(uiSql)).toContain("NOW() - ($1::int * INTERVAL '1 hour')");
    expect(String(uiSql)).not.toContain("INTERVAL '6 hours'");
    expect(uiParams).toEqual([6]);

    const [mappingSql, mappingParams] = mocks.db.query.mock.calls[3];
    expect(String(mappingSql)).toContain("NOW() - ($1::int * INTERVAL '1 hour')");
    expect(String(mappingSql)).not.toContain("INTERVAL '6 hours'");
    expect(mappingParams).toEqual([6]);

    const [healthSql, healthParams] = mocks.db.query.mock.calls[4];
    expect(String(healthSql)).toContain("SET flags = flags || $1::jsonb");
    expect(String(healthSql)).not.toContain("last_health_check\": \"");
    expect(JSON.parse(healthParams[0])).toHaveProperty("last_health_check");
  });
});
