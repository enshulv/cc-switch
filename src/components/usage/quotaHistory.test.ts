import { describe, it, expect } from "vitest";
import type { SubscriptionQuota } from "@/types/subscription";
import type { QuotaHistoryRow } from "@/lib/api/quotaHistory";
import {
  appsWithHistory,
  hourIndex,
  hourStartMs,
  latestTierEstimates,
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
 * 第 2 个点结算出第一段，斜率 100·ΔC/ΔU = 1000。
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
    const { estimates: out } = replayTierEstimates([
      { u: 10, c: 100 },
      { u: 20, c: 200 },
      { u: 30, c: 300 },
    ]);
    expect(out[0]).toBeNull(); // 首点只开段，还没有结算出任何段
    expect(out[1]).toBeCloseTo(1000, 6);
    expect(out[2]).toBeCloseTo(1000, 6);
  });

  it("estimates from the first settled one-point step", () => {
    const { estimates } = replayTierEstimates([
      { u: 10, c: 100 },
      { u: 11, c: 110 },
    ]);
    expect(estimates[0]).toBeNull();
    expect(estimates[1]).toBeCloseTo(1000, 6);
  });

  it("holds the last value across rows that carry no measured spend", () => {
    const { estimates: out } = replayTierEstimates([
      { u: 10, c: 100 },
      { u: 20, c: 200 },
      { u: 25, c: null },
    ]);
    expect(out[2]).toBe(out[1]);
  });

  it("starts a fresh segment after a window reset instead of folding across it", () => {
    // 前三点确立 $1000。随后 U 从 30 骤降到 2（窗口重置），新段的真实额度是 $2000
    // （U 每 +10 对应 C 每 +$200）。本用例只看 EMA 朝新斜率走；重置时旧段是否真被清空，
    // 回放层看不出来（旧段年龄 10pp，权重不到 1%），由 foldQuotaSample 的重置用例断言整个状态。
    const { estimates: out } = replayTierEstimates([
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
    // 账号在别的设备上烧掉了 20 个百分点（ΔU>0 但 ΔC=0）。这一格不结算成段、锚点前移到 30，
    // 下一格只按 30→40 结算 {$100, 10pp}。若把无本机花费的一格也推成段 {0, 20}，
    // EMA 先被拉到下界 $333，最后一点只到约 $667。
    const { estimates: out } = replayTierEstimates([
      { u: 10, c: 100 },
      { u: 30, c: 100 },
      { u: 40, c: 200 },
    ]);
    expect(out[2]).toBeCloseTo(1000, 6);
  });

  it("returns the state after the last sample", () => {
    const { estimates, state } = replayTierEstimates([
      { u: 10, c: 100 },
      { u: 20, c: 200 },
      { u: 25, c: null },
    ]);
    expect(state).not.toBeNull();
    expect(state!.display).toBe(estimates[1]);
    expect(state!.prevC).toBe(200);
    expect(state!.anchorU).toBe(20);
  });

  it("starts from the seed state when one is given", () => {
    const { state: seed } = replayTierEstimates([
      { u: 10, c: 100 },
      { u: 20, c: 200 },
    ]);
    const { estimates } = replayTierEstimates(
      [
        { u: 30, c: null },
        { u: 30, c: 300 },
      ],
      seed,
    );
    // 无花费的占位点输出种子的 display；下一点接着种子的段往下折，结算出 $1000
    expect(estimates[0]).toBeCloseTo(1000, 6);
    expect(estimates[1]).toBeCloseTo(1000, 6);
  });

  it("keeps a small-drop window reset from inflating the estimate", () => {
    // 真实形状：U 12→1 时 C 166.9→8.0。当抖动处理的话最后一点算出约 $2282。
    const { estimates } = replayTierEstimates([
      { u: 12, c: 166.9 },
      { u: 1, c: 8.0 },
      { u: 1, c: 11.4 },
      { u: 2, c: 13.3 },
      { u: 10, c: 89.2 },
      { u: 20, c: 190.6 },
    ]);
    for (const value of estimates.slice(3)) {
      expect(value).not.toBeNull();
      expect(value!).toBeLessThan(1100);
    }
  });

  it("keeps the estimate steady while C still carries the previous window's spend", () => {
    // 真实形状：U 53→0→0→2→3，C 1996→2031→2051→2086→2192，之后 C 跌到 5。
    // U=2 那点检测到重置，100·C/U 是估算值的 26 倍，进入 stale；C 跌到 5 时退出。
    const { estimates } = replayTierEstimates([
      { u: 52, c: 1956 },
      { u: 53, c: 1996 }, // 结算 $40/1pp，得 $4000
      { u: 0, c: 2031 },
      { u: 0, c: 2051 },
      { u: 2, c: 2086 },
      { u: 3, c: 2192 },
      { u: 4, c: 5 },
      { u: 5, c: 65 }, // 新窗口 $60/1pp，EMA 从 4000 走一半
    ]);
    expect(estimates[1]).toBeCloseTo(4000, 6);
    for (const value of estimates.slice(2, 7)) {
      expect(value).toBeCloseTo(4000, 6);
    }
    expect(estimates[7]).toBeCloseTo(5000, 6);
  });

  it("skips samples with zero utilization", () => {
    // U=0、C=$5 若被折入，会当成 C 回落的重置把段清空，下一点只按 0→21 结算。
    const { estimates } = replayTierEstimates([
      { u: 10, c: 100 },
      { u: 20, c: 200 },
      { u: 0, c: 5 },
      { u: 21, c: 230 },
    ]);
    expect(estimates[2]).toBeCloseTo(1000, 6);
    // 段 {100, 10}、{30, 1}：recent = 100·(30 + 100w)/(1 + 10w)，w = 0.5^(1/1.5)
    const w = 0.5 ** (1 / 1.5);
    const recent = (100 * (30 + 100 * w)) / (1 + 10 * w);
    expect(estimates[3]).toBeCloseTo(1000 + 0.5 * (recent - 1000), 6);
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

  it("carries the estimate across a gap without folding the gap's deltas", () => {
    // 断档前确立 $1000（U 24→25 花 $10）。停机期间窗口滚过，重开后 U=45、C=$90：
    // U 不降反升，重置判定碰不到，只有断档切段能挡住跨断档的差值。
    // 切段沿用：断档后第一点只开新段，显示沿用 $1000；下一点结算 $300/10pp 即 $3000，
    //   EMA 从 $1000 走一半到 $2000。
    // 跨断档硬折：第一点结算 {79, 20}，EMA 被拉到约 $698。
    // 从零开始：第一点是 null，第二点是 $3000。
    const { rows } = rowsToSeries(
      [
        row(10, "five_hour", 24, { spendUsd: 1 }),
        row(11, "five_hour", 25, { spendUsd: 11 }),
        row(30, "five_hour", 45, { spendUsd: 90 }),
        row(31, "five_hour", 55, { spendUsd: 390 }),
      ],
      "claude",
    );
    expect(rows.map((r) => r.ts)).toEqual([
      hourStartMs(10),
      hourStartMs(11),
      hourStartMs(12),
      hourStartMs(30),
      hourStartMs(31),
    ]);
    expect(rows[1].five_hour).toBeCloseTo(1000, 6);
    expect(rows[2].five_hour).toBeNull(); // 断线行
    expect(rows[3].five_hour).toBeCloseTo(1000, 6);
    expect(rows[4].five_hour).toBeCloseTo(2000, 6);
  });

  it("skips rows that measured zero spend", () => {
    // 探针在窗口内本机没花钱时写 spendUsd = 0。折入的话 C 从 $200 掉到 0，
    // 会被当成重置，h13 从 0 起算结算出 {230, 1}，估算冲到上万。
    const { rows } = rowsToSeries(
      [
        row(10, "five_hour", 10, { spendUsd: 100 }),
        row(11, "five_hour", 20, { spendUsd: 200 }),
        row(12, "five_hour", 20, { spendUsd: 0 }),
        row(13, "five_hour", 21, { spendUsd: 230 }),
      ],
      "claude",
    );
    expect(rows[2].five_hour).toBeCloseTo(1000, 6);
    const w = 0.5 ** (1 / 1.5);
    const recent = (100 * (30 + 100 * w)) / (1 + 10 * w);
    expect(rows[3].five_hour).toBeCloseTo(1000 + 0.5 * (recent - 1000), 6);
  });

  it("keeps ignoring stale spend across a gap", () => {
    // 真实形状：重置后 U 只有 2..5，C 却残留旧窗口的累计（约 $920..$1100），
    // 而且跨过了断档。断档后若不再忽略这些样本，C/U 会冲到上万。
    const { rows } = rowsToSeries(
      [
        row(10, "seven_day", 80, { spendUsd: 800 }),
        row(11, "seven_day", 81, { spendUsd: 820 }), // 结算 $20/1pp，得 $2000
        row(12, "seven_day", 2, { spendUsd: 920 }), // 重置，C 没回落：进入 stale
        row(13, "seven_day", 3, { spendUsd: 960 }),
        row(16, "seven_day", 4, { spendUsd: 1050 }),
        row(17, "seven_day", 5, { spendUsd: 1100 }),
      ],
      "claude",
    );
    // rows = [h10, h11, h12, h13, 断档行, h16, h17]
    expect(rows[4].seven_day).toBeNull();
    for (const index of [1, 2, 3, 5, 6]) {
      expect(rows[index].seven_day).toBeCloseTo(2000, 6);
    }
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

describe("latestTierEstimates", () => {
  it("takes each window's last non-null estimate for the requested app", () => {
    const rows = [
      row(10, "five_hour", 10, { spendUsd: 100 }),
      row(11, "five_hour", 20, { spendUsd: 200 }),
      row(12, "five_hour", 21, { spendUsd: 230 }), // $30/1pp，拉高 EMA
      row(10, "seven_day", 5, { spendUsd: 50 }),
      row(11, "seven_day", 6, { spendUsd: 70 }),
      row(10, "premium", 10, { appId: "codex", spendUsd: 100 }),
      row(11, "premium", 20, { appId: "codex", spendUsd: 500 }),
    ];
    const lastFiveHour = rowsToSeries(rows, "claude").rows.at(-1)!.five_hour;
    expect(lastFiveHour).not.toBeNull();
    expect(lastFiveHour).not.toBeCloseTo(1000, 0);

    const seeds = latestTierEstimates(rows, "claude");
    expect([...seeds.keys()].sort()).toEqual(["five_hour", "seven_day"]);
    expect(seeds.get("five_hour")).toBeCloseTo(lastFiveHour!, 6);
    expect(seeds.get("seven_day")).toBeCloseTo(2000, 6);
  });

  it("looks past hours where the window has no sample", () => {
    // seven_day 在最后一小时缺席，序列末尾是显式 null
    const rows = [
      row(10, "seven_day", 5, { spendUsd: 50 }),
      row(11, "seven_day", 6, { spendUsd: 70 }),
      row(12, "five_hour", 10, { spendUsd: 100 }),
    ];
    const seeds = latestTierEstimates(rows, "claude");
    expect(seeds.get("seven_day")).toBeCloseTo(2000, 6);
    expect(seeds.has("five_hour")).toBe(false);
  });

  it("looks past the null row inserted at a gap", () => {
    const rows = [
      row(10, "five_hour", 10, { spendUsd: 100 }),
      row(11, "five_hour", 20, { spendUsd: 200 }),
      row(30, "seven_day", 5, { spendUsd: 50 }),
    ];
    expect(latestTierEstimates(rows, "claude").get("five_hour")).toBeCloseTo(
      1000,
      6,
    );
  });

  it("returns no seeds when nothing has been estimated", () => {
    expect(latestTierEstimates([], "claude").size).toBe(0);
    expect(
      latestTierEstimates(
        [row(10, "five_hour", 10, { spendUsd: 100 })],
        "claude",
      ).size,
    ).toBe(0);
    expect(
      latestTierEstimates(
        [row(10, "five_hour", 10, { appId: "codex", spendUsd: 100 })],
        "claude",
      ).size,
    ).toBe(0);
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
