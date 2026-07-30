import { describe, it, expect } from "vitest";
import {
  tierWindowMs,
  tierModelPredicate,
  cumulativeQuotaUsd,
  deltaSlopeQuotaUsd,
  combineEstimates,
  foldEma,
  applyDeadband,
  classifyTrend,
  isEstimableApp,
  MIN_OBSERVED_DU,
  tierWindowStartSec,
  foldQuotaSample,
} from "./quotaEstimate";

const HOUR = 3_600_000;
const DAY = 86_400_000;

describe("tierWindowMs", () => {
  it("maps known window names", () => {
    expect(tierWindowMs("five_hour")).toBe(5 * HOUR);
    expect(tierWindowMs("seven_day")).toBe(7 * DAY);
    expect(tierWindowMs("seven_day_opus")).toBe(7 * DAY);
    expect(tierWindowMs("seven_day_sonnet")).toBe(7 * DAY);
    expect(tierWindowMs("weekly_limit")).toBe(7 * DAY);
    expect(tierWindowMs("30_day")).toBe(30 * DAY);
  });
  it("returns null for unknown windows (skips estimation)", () => {
    expect(tierWindowMs("gemini_pro")).toBeNull();
    expect(tierWindowMs("nonsense")).toBeNull();
  });
});

describe("tierModelPredicate", () => {
  it("opus tier only takes opus models", () => {
    const p = tierModelPredicate("seven_day_opus");
    expect(p("claude-opus-4-8")).toBe(true);
    expect(p("claude-sonnet-5")).toBe(false);
  });
  it("sonnet tier only takes sonnet models", () => {
    const p = tierModelPredicate("seven_day_sonnet");
    expect(p("claude-sonnet-5")).toBe(true);
    expect(p("claude-opus-4-8")).toBe(false);
  });
  it("shared tiers take every model", () => {
    const p = tierModelPredicate("five_hour");
    expect(p("claude-opus-4-8")).toBe(true);
    expect(p("claude-sonnet-5")).toBe(true);
    expect(p("gpt-5")).toBe(true);
  });
});

describe("cumulativeQuotaUsd (lower-bound from all local data)", () => {
  it("reverse-computes 100·C/U", () => {
    expect(cumulativeQuotaUsd(3, 1)).toBeCloseTo(300);
    expect(cumulativeQuotaUsd(12, 30)).toBeCloseTo(40);
  });
  it("returns null on non-positive percentage or spend", () => {
    expect(cumulativeQuotaUsd(5, 0)).toBeNull();
    expect(cumulativeQuotaUsd(5, -1)).toBeNull();
    expect(cumulativeQuotaUsd(0, 15)).toBeNull();
    expect(cumulativeQuotaUsd(NaN, 10)).toBeNull();
  });
});

describe("deltaSlopeQuotaUsd (baseline-robust incremental)", () => {
  it("is null until enough window movement is observed", () => {
    // ΣΔU below the gate → hidden, regardless of ΣΔC
    expect(deltaSlopeQuotaUsd(2, MIN_OBSERVED_DU - 1)).toBeNull();
    expect(deltaSlopeQuotaUsd(0, 10)).toBeNull();
  });
  it("returns 100·ΣΔC/ΣΔU once the gate is met", () => {
    // spent $10 while 5% of the window elapsed → total ≈ $200
    expect(deltaSlopeQuotaUsd(10, 5)).toBeCloseTo(200);
    // the historical baseline is irrelevant: only the accumulated deltas matter
    expect(deltaSlopeQuotaUsd(30, 6)).toBeCloseTo(500);
  });
  it("honors a custom gate", () => {
    expect(deltaSlopeQuotaUsd(10, 8, 10)).toBeNull();
    expect(deltaSlopeQuotaUsd(10, 10, 10)).toBeCloseTo(100);
  });
});

describe("combineEstimates (delta primary, cumulative floor)", () => {
  it("is null while the delta estimate is not yet available", () => {
    expect(combineEstimates(null, 1200)).toBeNull();
    expect(combineEstimates(null, null)).toBeNull();
  });
  it("takes the delta when there is no cumulative floor", () => {
    expect(combineEstimates(1500, null)).toBe(1500);
  });
  it("floors the delta at the cumulative lower bound (uses both)", () => {
    // delta noisy-low → cumulative floor catches it
    expect(combineEstimates(900, 1200)).toBe(1200);
    // multi-surface: delta recovers the true (higher) value, cumulative is loose
    expect(combineEstimates(2000, 800)).toBe(2000);
  });
});

describe("foldEma", () => {
  it("uses the first sample as the initial value", () => {
    expect(foldEma(null, 100)).toBe(100);
  });
  it("converges toward the true value without overshooting", () => {
    let ema: number | null = 100;
    for (let i = 0; i < 20; i++) ema = foldEma(ema, 200);
    expect(ema).toBeGreaterThan(190);
    expect(ema).toBeLessThanOrEqual(200);
  });
  it("smooths noise (does not fully track a single sample)", () => {
    const next = foldEma(100, 300);
    expect(next).toBeGreaterThan(100);
    expect(next).toBeLessThan(300);
  });
});

describe("applyDeadband", () => {
  it("uses the EMA directly when there is no prior display value", () => {
    expect(applyDeadband(null, 1800)).toBe(1800);
    expect(applyDeadband(0, 1800)).toBe(1800);
  });
  it("holds the previous value while the EMA stays within the 2% band", () => {
    expect(applyDeadband(1800, 1819)).toBe(1800);
    expect(applyDeadband(1800, 1780)).toBe(1800);
  });
  it("snaps to the EMA once it drifts past the band", () => {
    expect(applyDeadband(1800, 1850)).toBe(1850);
    expect(applyDeadband(1800, 1750)).toBe(1750);
  });
});

describe("classifyTrend", () => {
  it("treats a missing baseline as flat", () => {
    expect(classifyTrend(null, 100)).toBe("flat");
    expect(classifyTrend(0, 100)).toBe("flat");
  });
  it("treats small moves within the threshold as flat", () => {
    expect(classifyTrend(100, 105)).toBe("flat"); // +5% < 8%
  });
  it("detects significant rises/drops", () => {
    expect(classifyTrend(100, 130)).toBe("up"); // provider raised quota
    expect(classifyTrend(100, 70)).toBe("down"); // provider cut quota
  });
});

describe("isEstimableApp", () => {
  it("only claude / codex are estimable", () => {
    expect(isEstimableApp("claude")).toBe(true);
    expect(isEstimableApp("codex")).toBe(true);
    expect(isEstimableApp("gemini")).toBe(false);
    expect(isEstimableApp(undefined)).toBe(false);
  });
});

describe("tierWindowStartSec", () => {
  it("returns Unix SECONDS, not millis", () => {
    // 这个函数存在的唯一理由就是这个陷阱：get_model_stats 收秒，传毫秒会把区间
    // 推到未来、查不到任何消耗，C 静默变 0，页脚和图表一起变空白。
    const resetsAt = new Date(1_800_000_000_000).toISOString();
    const start = tierWindowStartSec({ name: "five_hour", resetsAt })!;
    expect(start).toBe(1_800_000_000 - 5 * 3600);
    // 秒级时间戳在 2001-2286 年间是 10 位数；毫秒是 13 位
    expect(String(start).length).toBe(10);
  });

  it("returns null for windows with no known length or no reset time", () => {
    expect(
      tierWindowStartSec({
        name: "gemini_pro",
        resetsAt: new Date().toISOString(),
      }),
    ).toBeNull();
    expect(
      tierWindowStartSec({ name: "five_hour", resetsAt: null }),
    ).toBeNull();
    expect(
      tierWindowStartSec({ name: "five_hour", resetsAt: "not a date" }),
    ).toBeNull();
  });
});

describe("foldQuotaSample", () => {
  it("needs a previous sample before the delta estimator can gate open", () => {
    const first = foldQuotaSample(null, 100, 10);
    expect(first.display).toBeNull();
    expect(first.prevC).toBe(100);
    expect(first.prevU).toBe(10);
  });

  it("converges on the slope, not on the cumulative ratio", () => {
    // 账号在别处已烧掉基数：累积法给 100·100/50 = $200，增量法给 100·100/10 = $1000。
    const first = foldQuotaSample(null, 100, 50);
    const second = foldQuotaSample(first, 200, 60);
    expect(second.display).toBeCloseTo(1000, 6);
  });

  it("drops intervals with window movement but no local spend", () => {
    const first = foldQuotaSample(null, 100, 10);
    const offDevice = foldQuotaSample(first, 100, 30); // ΔU=20, ΔC=0
    expect(offDevice.sumDU).toBe(0);
    expect(offDevice.display).toBeNull();
  });

  it("clears the accumulators when the window resets", () => {
    const a = foldQuotaSample(null, 100, 40);
    const b = foldQuotaSample(a, 200, 50);
    expect(b.sumDU).toBe(10);
    const afterReset = foldQuotaSample(b, 10, 2); // U 骤降 → 重置
    expect(afterReset.sumDU).toBe(0);
    expect(afterReset.sumDC).toBe(0);
  });

  it("only accepts the cumulative bootstrap when provisional is allowed", () => {
    expect(foldQuotaSample(null, 100, 50).display).toBeNull();
    expect(foldQuotaSample(null, 100, 50, true).display).toBeCloseTo(200, 6);
  });
});
