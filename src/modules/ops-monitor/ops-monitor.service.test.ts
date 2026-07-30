import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ db: { query: vi.fn() } }));

vi.mock("../../db/client", () => ({ getDb: () => mocks.db }));

import { runOpsMonitor } from "./ops-monitor.service";

describe("ops monitor SQL bindings", () => {
  beforeEach(() => mocks.db.query.mockReset());
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("binds lookback values instead of interpolating them into interval SQL text", async () => {
    mocks.db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const hostileLookback = "6'; DROP TABLE navigation_logs; --" as unknown as number;
    await runOpsMonitor({ lookback_hours: hostileLookback });

    const [uiSql, uiParams] = mocks.db.query.mock.calls[0];
    expect(String(uiSql)).toContain("NOW() - ($1::int * INTERVAL '1 hour')");
    expect(String(uiSql)).not.toContain(String(hostileLookback));
    expect(uiParams).toEqual([hostileLookback]);
    expect(uiParams).toHaveLength(1);

    const [mappingSql, mappingParams] = mocks.db.query.mock.calls[3];
    expect(String(mappingSql)).toContain("NOW() - ($1::int * INTERVAL '1 hour')");
    expect(String(mappingSql)).not.toContain(String(hostileLookback));
    expect(mappingParams).toEqual([hostileLookback]);
    expect(mappingParams).toHaveLength(1);

    const deviceSql = String(mocks.db.query.mock.calls[1][0]);
    expect(deviceSql).toContain("lifecycle_state_matches(");
    expect(deviceSql).not.toContain("status IN");
    expect(deviceSql).not.toContain("status NOT IN");
  });

  it("binds device health JSONB and keeps timestamp text out of SQL", async () => {
    const hostileTimestamp = "2026-07-30T14:33:52.490Z'\"\\\\} || pg_sleep(10) --";
    vi.spyOn(Date.prototype, "toISOString").mockReturnValue(hostileTimestamp);
    mocks.db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await runOpsMonitor({ lookback_hours: 1 });

    const [healthSql, healthParams] = mocks.db.query.mock.calls[4];
    expect(String(healthSql)).toContain("SET flags = flags || $1::jsonb");
    expect(String(healthSql)).not.toContain(hostileTimestamp);
    expect(String(healthSql)).toContain("lifecycle_state_matches(");
    expect(String(healthSql)).not.toContain("status IN");
    expect(String(healthSql)).not.toContain("status NOT IN");
    expect(healthParams).toEqual([JSON.stringify({ last_health_check: hostileTimestamp })]);
    expect(healthParams).toHaveLength(1);
  });
});
