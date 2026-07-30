import { describe, it, expect } from "vitest";
import type { SubscriptionQuota } from "@/types/subscription";
import type { QuotaHistoryRow } from "@/lib/api/quotaHistory";
import {
  appsWithHistory,
  hourIndex,
  hourStartMs,
  replayTierEstimates,
  rowsToSeries,
  toQuotaSamples,
  utilKey,
} from "./quotaHistory";

const HOUR = 3_600_000;

function quota(
  tiers: Array<{
    name: string;
    utilization: number;
    usedValueUsd?: number | null;
    maxValueUsd?: number | null;
  }>,
  queriedAt: number | null,
  success = true,
): SubscriptionQuota {
  return {
    tool: "claude",
    credentialStatus: "valid",
    credentialMessage: null,
    success,
    tiers: tiers.map((t) => ({ resetsAt: null, ...t })),
    extraUsage: null,
    error: null,
    queriedAt,
  };
}

function row(
  hour: number,
  tier: string,
  utilization: number,
  extra: Partial<QuotaHistoryRow> = {},
): QuotaHistoryRow {
  return {
    appId: "claude",
    hour,
    tier,
    utilization,
    usedUsd: null,
    maxUsd: null,
    spendUsd: null,
    ...extra,
  };
}

/**
 * 一条会收敛的序列：额度恰好 $1000（U 每步 +10，C 每步 +$100）。
 * MIN_OBSERVED_DU=5，所以第 2 个点就够门槛，斜率 100·ΔC/ΔU = 1000。
 */
function convergingRows(tier = "five_hour"): QuotaHistoryRow[] {
  return [10, 20, 30].map((u, i) =>
    row(10 + i, tier, u, { spendUsd: (u / 10) * 100 }),
  );
}

describe("hourIndex", () => {
  it("floors to the epoch hour, including before the epoch", () => {
    expect(hourIndex(10 * HOUR + 59 * 60_000)).toBe(10);
    expect(hourStartMs(hourIndex(10 * HOUR + 59 * 60_000))).toBe(10 * HOUR);
    expect(hourIndex(-1)).toBe(-1);
  });
});

describe("toQuotaSamples", () => {
  it("stamps the sample with the measurement time, not the wall clock", () => {
    const measured = 100 * HOUR + 12 * 60_000;
    const sample = toQuotaSamples(
      quota([{ name: "five_hour", utilization: 42.5 }], measured),
      500 * HOUR,
    );
    expect(sample).not.toBeNull();
    expect(sample!.measuredAt).toBe(measured);
    expect(sample!.tiers).toEqual([
      {
        name: "five_hour",
        utilization: 42.5,
        usedUsd: null,
        maxUsd: null,
        spendUsd: null,
      },
    ]);
  });

  it("carries the dollar figures when the provider exposes them", () => {
    const sample = toQuotaSamples(
      quota(
        [
          {
            name: "seven_day",
            utilization: 10,
            usedValueUsd: 12.34,
            maxValueUsd: 200,
          },
        ],
        HOUR,
      ),
      HOUR,
      { seven_day: 41.5 },
    );
    expect(sample!.tiers[0]).toEqual({
      name: "seven_day",
      utilization: 10,
      usedUsd: 12.34,
      maxUsd: 200,
      spendUsd: 41.5,
    });
  });

  it("falls back to now when the reading has no queriedAt", () => {
    const sample = toQuotaSamples(
      quota([{ name: "five_hour", utilization: 5 }], null),
      7 * HOUR,
    );
    expect(sample!.measuredAt).toBe(7 * HOUR);
  });

  it("records nothing for failed, empty or unusable readings", () => {
    expect(toQuotaSamples(undefined, HOUR)).toBeNull();
    expect(
      toQuotaSamples(
        quota([{ name: "five_hour", utilization: 5 }], HOUR, false),
        HOUR,
      ),
    ).toBeNull();
    expect(toQuotaSamples(quota([], HOUR), HOUR)).toBeNull();
    expect(
      toQuotaSamples(
        quota([{ name: "five_hour", utilization: NaN }], HOUR),
        HOUR,
      ),
    ).toBeNull();
  });

  it("drops unusable tiers but keeps the usable ones", () => {
    const sample = toQuotaSamples(
      quota(
        [
          { name: "five_hour", utilization: -1 },
          { name: "seven_day", utilization: 20 },
        ],
        HOUR,
      ),
      HOUR,
    );
    expect(sample!.tiers.map((t) => t.name)).toEqual(["seven_day"]);
  });
});

describe("replayTierEstimates", () => {
  it("converges to the true quota once enough window movement is seen", () => {
    // 额度 $1000：U 10→20→30，C $100→$200→$300
    const out = replayTierEstimates([
      { u: 10, c: 100 },
      { u: 20, c: 200 },
      { u: 30, c: 300 },
    ]);
    expect(out[0]).toBeNull(); // 首点没有增量，未达门槛
    expect(out[1]).toBeCloseTo(1000, 6);
    expect(out[2]).toBeCloseTo(1000, 6);
  });

  it("stays null while window movement is below the gate", () => {
    // ΣΔU = 1 < MIN_OBSERVED_DU
    const out = replayTierEstimates([
      { u: 10, c: 100 },
      { u: 11, c: 110 },
    ]);
    expect(out).toEqual([null, null]);
  });

  it("holds the last value across rows that carry no measured spend", () => {
    const out = replayTierEstimates([
      { u: 10, c: 100 },
      { u: 20, c: 200 },
      { u: 25, c: null },
    ]);
    expect(out[2]).toBe(out[1]);
  });

  it("starts a fresh segment after a window reset instead of folding across it", () => {
    // 前三点确立 $1000。随后 U 从 30 骤降到 2（窗口重置），新段的真实额度是 $2000
    // （U 每 +10 对应 C 每 +$200）。若删掉重置清零那一支，累加器会把跨重置的
    // ΔC/ΔU 混进老段，斜率被拉向 $1000 附近——本用例即以此判定重置是否真的生效。
    const out = replayTierEstimates([
      { u: 10, c: 100 },
      { u: 20, c: 200 },
      { u: 30, c: 300 },
      { u: 2, c: 20 },
      { u: 12, c: 220 },
      { u: 22, c: 420 },
    ]);
    expect(out[2]).toBeCloseTo(1000, 6);
    // 新段自己的斜率是 100·200/10 = 2000，EMA 从 1000 朝 2000 走
    expect(out[4]).toBeGreaterThan(1300);
    expect(out[5]).toBeGreaterThan(out[4]!);
    expect(out[5]).toBeLessThanOrEqual(2000);
  });

  it("ignores intervals where the window moved without local spend", () => {
    // 账号在别的设备上烧掉了 20 个百分点（ΔU>0 但 ΔC=0）——这正是增量法存在的理由。
    // 若把 `dU > 0 && dC > 0` 放宽成 `dU > 0`，这段会进入分母，斜率从 $1000 掉到 $400。
    const out = replayTierEstimates([
      { u: 10, c: 100 },
      { u: 30, c: 100 },
      { u: 40, c: 200 },
    ]);
    expect(out[2]).toBeCloseTo(1000, 6);
  });
});

describe("rowsToSeries", () => {
  it("plots the replayed dollar quota and carries utilization for the tooltip", () => {
    const { tiers, rows, warmingUp } = rowsToSeries(convergingRows(), "claude");

    expect(tiers).toEqual(["five_hour"]);
    expect(rows).toHaveLength(3);
    expect(warmingUp).toBe(false);
    expect(rows[0].ts).toBe(hourStartMs(10));
    expect(rows[0].five_hour).toBeNull(); // 首点未收敛
    expect(rows[1].five_hour).toBeCloseTo(1000, 6);
    expect(rows[1][utilKey("five_hour")]).toBe(20);
  });

  it("flags warming-up when nothing converged yet", () => {
    const { rows, warmingUp } = rowsToSeries(
      [row(10, "five_hour", 10, { spendUsd: 100 })],
      "claude",
    );
    expect(warmingUp).toBe(true);
    expect(rows[0].five_hour).toBeNull();
  });

  it("replays each window independently", () => {
    const rows = [
      ...convergingRows("five_hour"),
      ...convergingRows("seven_day"),
    ];
    const series = rowsToSeries(rows, "claude");
    expect(series.tiers.sort()).toEqual(["five_hour", "seven_day"]);
    expect(series.rows[1].five_hour).toBeCloseTo(1000, 6);
    expect(series.rows[1].seven_day).toBeCloseTo(1000, 6);
  });

  it("inserts a null row so long gaps break the line", () => {
    const { rows } = rowsToSeries(
      [
        row(10, "five_hour", 10, { spendUsd: 100 }),
        row(20, "five_hour", 20, { spendUsd: 200 }),
      ],
      "claude",
    );
    expect(rows).toHaveLength(3);
    expect(rows[1].ts).toBe(hourStartMs(11));
    expect(rows[1].five_hour).toBeNull();
  });

  it("keeps consecutive hours connected", () => {
    const { rows } = rowsToSeries(convergingRows(), "claude");
    expect(rows.map((r) => r.ts)).toEqual([
      hourStartMs(10),
      hourStartMs(11),
      hourStartMs(12),
    ]);
  });

  it("only reads the requested app", () => {
    const rows = [
      row(10, "five_hour", 20, { spendUsd: 100 }),
      row(10, "premium", 90, { appId: "codex", spendUsd: 100 }),
    ];
    expect(rowsToSeries(rows, "claude").tiers).toEqual(["five_hour"]);
    expect(rowsToSeries(rows, "codex").tiers).toEqual(["premium"]);
    expect(rowsToSeries(rows, "gemini").rows).toEqual([]);
  });

  it("marks a window absent for an hour as an explicit null", () => {
    // seven_day 只在第一个小时有样本；否则 recharts 会把它一路平推
    const { rows } = rowsToSeries(
      [
        row(10, "five_hour", 10, { spendUsd: 100 }),
        row(10, "seven_day", 5, { spendUsd: 50 }),
        row(11, "five_hour", 20, { spendUsd: 200 }),
      ],
      "claude",
    );
    expect(rows[1].seven_day).toBeNull();
    expect(rows[1][utilKey("seven_day")]).toBeNull();
  });

  it("sorts hours that arrive out of order before replaying them", () => {
    // 断言值而不只是 ts：顺序反了的话 dU 变成负数、什么都不累加，两点都会是 null。
    const { rows } = rowsToSeries(
      [
        row(12, "five_hour", 30, { spendUsd: 300 }),
        row(11, "five_hour", 20, { spendUsd: 200 }),
      ],
      "claude",
    );
    expect(rows.map((r) => r.ts)).toEqual([hourStartMs(11), hourStartMs(12)]);
    expect(rows[1].five_hour).toBeCloseTo(1000, 6);
  });

  it("restarts the estimator across a gap instead of folding through it", () => {
    // 停机期间 5h 窗口滚过若干轮，C 已归零重算——跨断档的 ΔC 不在同一根轴上。
    // 若断档处不重置，dU=+20/dC=+80 会算出 $400（真实是 $200 那一档），并被 EMA 吸收。
    const { rows } = rowsToSeries(
      [
        row(10, "five_hour", 5, { spendUsd: 10 }),
        row(11, "five_hour", 25, { spendUsd: 10 }),
        row(30, "five_hour", 45, { spendUsd: 90 }),
      ],
      "claude",
    );
    const afterGap = rows[rows.length - 1];
    expect(afterGap.five_hour).toBeNull();
  });

  it("fills gap rows with explicit nulls for every tier", () => {
    const { rows } = rowsToSeries(
      [
        row(10, "five_hour", 10, { spendUsd: 100 }),
        row(10, "seven_day", 5, { spendUsd: 50 }),
        row(30, "five_hour", 20, { spendUsd: 200 }),
      ],
      "claude",
    );
    // rows = [h10, 断档行, h30]
    const gap = rows[1];
    // undefined 会让 QuotaSeriesRow 的类型签名变成谎话，断线只是碰巧生效
    expect(gap.five_hour).toBeNull();
    expect(gap.seven_day).toBeNull();
    expect(gap[utilKey("five_hour")]).toBeNull();
  });

  it("reports not-estimable rather than warming-up when no spend was ever measured", () => {
    // Gemini 这类没有窗口长度的 tier、以及 v3.19.6 落的老行，spendUsd 永远是 null。
    // 那种情况说「还在预热，继续用就好」是骗人的——等一辈子也不会出数。
    const { warmingUp, estimable } = rowsToSeries(
      [row(10, "gemini_pro", 10), row(11, "gemini_pro", 20)],
      "claude",
    );
    expect(estimable).toBe(false);
    expect(warmingUp).toBe(false);
  });
});

describe("appsWithHistory", () => {
  it("keeps the candidate order and skips apps without rows", () => {
    const rows = [row(10, "five_hour", 20, { appId: "codex" })];
    expect(appsWithHistory(rows, ["claude", "codex", "gemini"])).toEqual([
      "codex",
    ]);
    expect(appsWithHistory([], ["claude", "codex"])).toEqual([]);
  });
});
