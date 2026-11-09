import { describe, it, expect } from "vitest";
import {
  tierWindowMs,
  tierModelPredicate,
  cumulativeQuotaUsd,
  foldEma,
  applyDeadband,
  classifyTrend,
  isEstimableApp,
  tierWindowStartSec,
  foldQuotaSample,
  startNewSegment,
  seededEstimator,
  RECENCY_HALF_LIFE_PP,
  type EstimatorState,
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
  it("moves halfway toward each new sample", () => {
    expect(foldEma(100, 300)).toBe(200);
    expect(foldEma(200, 100)).toBe(150);
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
    const start = tierWindowStartSec(
      { name: "five_hour", resetsAt },
      1_800_000_000_000 - HOUR,
    )!;
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
  it("returns null once the window's reset time has passed", () => {
    // 过期的 resetsAt 推出的是上一个窗口的起点，量出的 C 是旧窗口的累计。
    const resetsMs = 1_800_000_000_000;
    const resetsAt = new Date(resetsMs).toISOString();
    expect(
      tierWindowStartSec({ name: "five_hour", resetsAt }, resetsMs),
    ).toBeNull();
    expect(
      tierWindowStartSec({ name: "five_hour", resetsAt }, resetsMs + 1),
    ).toBeNull();
    expect(
      tierWindowStartSec({ name: "seven_day", resetsAt }, resetsMs - 1),
    ).toBe(1_800_000_000 - 7 * 86_400);
  });
});

/** 段状态全空、估算值可选覆写的估算器状态 */
function estimator(overrides: Partial<EstimatorState> = {}): EstimatorState {
  return {
    prevC: null,
    anchorU: null,
    pendingDC: 0,
    spans: [],
    stale: null,
    ema: null,
    display: null,
    baseline: null,
    ...overrides,
  };
}

/** 依序折入 [C, U] 样本，回传每一步之后的状态 */
function foldEach(
  start: EstimatorState | null,
  samples: Array<[number, number]>,
  allowProvisional = false,
): EstimatorState[] {
  const states: EstimatorState[] = [];
  let state = start;
  for (const [c, u] of samples) {
    state = foldQuotaSample(state, c, u, allowProvisional);
    states.push(state);
  }
  return states;
}

function lastOf<T>(items: T[]): T {
  return items[items.length - 1];
}

/** 契约的权重公式，半衰期写成字面量 1.5pp，不取被测模块的常数 */
const recencyWeight = (age: number) => 0.5 ** (age / 1.5);

describe("foldQuotaSample", () => {
  it("opens a segment on the first sample without producing an estimate", () => {
    const first = foldQuotaSample(null, 100, 10);
    expect(first).toEqual(estimator({ prevC: 100, anchorU: 10 }));
  });

  it("settles all spend since the last step of U into the span, not just the final interval", () => {
    // U 是整数：C 涨了三次，U 才跳一格。跳格那个区间只花了 $15，整段花了 $40。
    const states = foldEach(null, [
      [100, 10],
      [110, 10],
      [125, 10],
      [140, 11],
    ]);
    expect(states[2].pendingDC).toBe(25);
    expect(states[2].spans).toEqual([]);
    const settled = lastOf(states);
    expect(settled.spans).toEqual([{ dC: 40, dU: 1 }]);
    expect(settled.pendingDC).toBe(0);
    expect(settled.anchorU).toBe(11);
    // recent = 100·40/1 = 4000，高于累积下界 100·140/11 ≈ 1273
    expect(settled.display).toBeCloseTo(4000, 6);
  });

  it("does not count a 52 → 51 → 52 jitter as a step of U", () => {
    const states = foldEach(null, [
      [100, 52],
      [110, 51],
      [120, 52],
    ]);
    const back = lastOf(states);
    expect(back.spans).toEqual([]);
    expect(back.anchorU).toBe(52);
    expect(back.pendingDC).toBe(20);
    expect(back.display).toBeNull();

    const stepped = foldQuotaSample(back, 130, 53);
    expect(stepped.spans).toEqual([{ dC: 30, dU: 1 }]);
  });

  it("treats a small drop of U with falling C as a window reset", () => {
    // 真实形状：5h 窗口在 U<20 时重置，U 14→5 时 C 102.0→37.4。窗口内 C 只增不减，
    // C 回落只可能是重置；当抖动处理的话锚点停在 14，之后的涨幅少算 9 格。
    const states = foldEach(null, [
      [102.0, 14],
      [37.4, 5],
      [107.8, 14],
      [166.4, 24],
    ]);
    expect(states[1]).toEqual(estimator({ prevC: 37.4, anchorU: 5 }));
    expect(states[2].spans).toHaveLength(1);
    expect(states[2].spans[0].dU).toBe(9);
    expect(states[2].spans[0].dC).toBeCloseTo(70.4, 9);
    // 两段合计 19 格；丢掉最旧的 9 格后仍覆盖 10 格，所以只留最新一段
    const final = lastOf(states);
    expect(final.spans).toHaveLength(1);
    expect(final.spans[0].dU).toBe(10);
    expect(final.spans[0].dC).toBeCloseTo(58.6, 9);
  });

  it("settles the full rise after a small-drop reset", () => {
    // 真实形状：U 12→1 时 C 166.9→8.0，之后 U 1→20 共涨 19 格。
    // 当抖动处理的话最后只按 dU=8 结算 $182.6，估算膨胀到 $2282。
    const states = foldEach(null, [
      [166.9, 12],
      [8.0, 1],
      [11.4, 1],
      [13.3, 2],
      [89.2, 10],
      [190.6, 20],
    ]);
    expect(states[1].anchorU).toBe(1);
    expect(states[1].stale).toBeNull();

    // 逐步结算的段：1 + 8 + 10 = 19 格
    expect(states[3].spans).toHaveLength(1);
    expect(states[3].spans[0].dU).toBe(1);
    expect(states[3].spans[0].dC).toBeCloseTo(5.3, 9);
    expect(states[4].spans).toHaveLength(2);
    expect(states[4].spans[1].dU).toBe(8);
    expect(states[4].spans[1].dC).toBeCloseTo(75.9, 9);
    const final = lastOf(states);
    expect(lastOf(final.spans).dU).toBe(10);
    expect(lastOf(final.spans).dC).toBeCloseTo(101.4, 9);

    // 手算 EMA（α=0.5）：
    //   第 3 步只有 {5.3, 1}：recent 530，下界 100·13.3/2 = 665，EMA 665；
    //   第 4 步 {5.3, 1}、{75.9, 8}：recent = 100·(75.9 + 5.3·2^(−16/3)) ÷ (8 + 2^(−16/3))
    //     ≈ 947.456，EMA ≈ 806.228；
    //   第 5 步先裁剪，只剩 {101.4, 10}：recent 1014，下界 953，EMA ≈ 910.114。
    // 不裁剪就估算的话三段都带权重，EMA ≈ 909.853。
    expect(final.ema).toBeCloseTo(910.114, 2);
    expect(final.display).toBeCloseTo(910.114, 2);
  });

  it("treats a drop of one point as jitter and a drop of two as a reset", () => {
    const jitter = lastOf(
      foldEach(null, [
        [100, 50],
        [110, 49],
      ]),
    );
    expect(jitter.anchorU).toBe(50);
    expect(jitter.pendingDC).toBe(10);

    const reset = lastOf(
      foldEach(null, [
        [100, 50],
        [110, 48],
      ]),
    );
    expect(reset).toEqual(estimator({ prevC: 110, anchorU: 48 }));
  });

  it("treats C falling by more than $0.5 as a reset whichever way U moves", () => {
    const base = estimator({
      prevC: 100,
      anchorU: 30,
      pendingDC: 4,
      spans: [{ dC: 10, dU: 1 }],
      ema: 1000,
      display: 1000,
      baseline: 1000,
    });
    const reset = estimator({
      prevC: 99.4,
      ema: 1000,
      display: 1000,
      baseline: 1000,
    });
    expect(foldQuotaSample(base, 99.4, 30)).toEqual({ ...reset, anchorU: 30 });
    expect(foldQuotaSample(base, 99.4, 34)).toEqual({ ...reset, anchorU: 34 });
  });

  it("treats C falling by $0.5 or less as measurement noise", () => {
    const base = estimator({
      prevC: 100,
      anchorU: 30,
      pendingDC: 4,
      spans: [{ dC: 10, dU: 1 }],
    });
    // U 没跳格：负的 dC 不从累积里扣
    const held = foldQuotaSample(base, 99.6, 30);
    expect(held.pendingDC).toBe(4);
    expect(held.anchorU).toBe(30);
    expect(held.spans).toEqual([{ dC: 10, dU: 1 }]);
    expect(held.prevC).toBe(99.6);

    // U 跳格：结算的只有之前累积的 $4，负的 dC 不扣
    const stepped = foldQuotaSample(base, 99.6, 31);
    expect(stepped.spans).toEqual([
      { dC: 10, dU: 1 },
      { dC: 4, dU: 1 },
    ]);
    expect(stepped.pendingDC).toBe(0);
  });

  it("re-anchors on a small drop of U with C still rising", () => {
    // 多机：旧窗口本机只花了 $2，别台机器把 U 推到 18；新窗口本机先用，C 比旧窗口末尾高。
    // 真实额度 $100（$1/pp）。不当重置的话锚点卡在 18，U=19 时结算出 {17, 1}。
    const prev = estimator({
      prevC: 2,
      anchorU: 18,
      ema: 100,
      display: 100,
      baseline: 100,
    });
    const states = foldEach(prev, [
      [3, 3],
      [18, 18],
      [19, 19],
    ]);
    expect(states[0]).toEqual({ ...prev, prevC: 3, anchorU: 3 });
    expect(lastOf(states).display).toBeCloseTo(100, 6);
  });

  it("enters stale on a reset with no estimate only when U drops by more than 20 points", () => {
    const stale = lastOf(
      foldEach(null, [
        [100, 50],
        [110, 29],
      ]),
    );
    expect(stale).toEqual(
      estimator({ prevC: 100, anchorU: 29, stale: { refC: 100 } }),
    );

    const reset = lastOf(
      foldEach(null, [
        [100, 50],
        [110, 30],
      ]),
    );
    expect(reset).toEqual(estimator({ prevC: 110, anchorU: 30 }));
  });

  it("enters stale on a reset once 100·C/U exceeds four times the estimate", () => {
    const prev = estimator({
      prevC: 100,
      anchorU: 15,
      spans: [{ dC: 10, dU: 1 }],
      ema: 1000,
      display: 1000,
      baseline: 1000,
    });
    const kept = { ema: 1000, display: 1000, baseline: 1000 };

    // 100·410/10 = 4100，是估算值的 4.1 倍
    expect(foldQuotaSample(prev, 410, 10)).toEqual(
      estimator({ ...kept, prevC: 100, anchorU: 10, stale: { refC: 100 } }),
    );
    // 100·390/10 = 3900，3.9 倍：正常重置，C 照常前推
    expect(foldQuotaSample(prev, 390, 10)).toEqual(
      estimator({ ...kept, prevC: 390, anchorU: 10 }),
    );
    // 有估算值时，降幅超过 20 格也按比值判定
    const largeDrop = foldQuotaSample({ ...prev, anchorU: 50 }, 390, 10);
    expect(largeDrop.stale).toBeNull();
    expect(largeDrop.prevC).toBe(390);
  });

  it("moves the anchor without a span when U steps with no local spend", () => {
    // 别台机器烧掉 2 个百分点，本机没花钱：不推段，锚点前移。
    const offDevice = lastOf(
      foldEach(null, [
        [100, 10],
        [100, 12],
      ]),
    );
    expect(offDevice.spans).toEqual([]);
    expect(offDevice.anchorU).toBe(12);
    expect(offDevice.display).toBeNull();

    // 下一格从 12 量起，不是 10
    const next = foldQuotaSample(offDevice, 150, 13);
    expect(next.spans).toEqual([{ dC: 50, dU: 1 }]);
    expect(next.display).toBeCloseTo(5000, 6);
  });

  it("weights the newest span highest", () => {
    // 两段各 1pp：旧段 $10（斜率 $1000），新段 $30（斜率 $3000）
    const prev = estimator({
      prevC: 110,
      anchorU: 11,
      spans: [{ dC: 10, dU: 1 }],
    });
    const next = foldQuotaSample(prev, 140, 12);
    const w = recencyWeight(1);
    const expected = (100 * (30 + w * 10)) / (1 + w);
    expect(RECENCY_HALF_LIFE_PP).toBe(1.5);
    expect(expected).toBeCloseTo(2227.0, 1);
    expect(next.ema).toBeCloseTo(expected, 6);
    expect(next.display).toBeCloseTo(expected, 6);
    expect(next.spans).toEqual([
      { dC: 10, dU: 1 },
      { dC: 30, dU: 1 },
    ]);
  });

  it("ages each span by the percentage points of the spans newer than it", () => {
    const prev = estimator({
      prevC: 150,
      anchorU: 13,
      spans: [
        { dC: 10, dU: 1 },
        { dC: 40, dU: 2 },
      ],
    });
    const next = foldQuotaSample(prev, 180, 14);
    // 年龄：新段 0，中段 1（新段 1pp），旧段 3（新段 1pp 加中段 2pp）
    const expected =
      (100 * (30 + 40 * recencyWeight(1) + 10 * recencyWeight(3))) /
      (1 + 2 * recencyWeight(1) + 1 * recencyWeight(3));
    expect(next.ema).toBeCloseTo(expected, 6);
  });

  it("floors the recent slope at the cumulative lower bound", () => {
    const prev = estimator({ prevC: 1000, anchorU: 50 });
    const next = foldQuotaSample(prev, 1005, 51);
    // recent = 100·5/1 = 500，累积 = 100·1005/51 ≈ 1970.6
    expect(next.ema).toBeCloseTo((1005 / 51) * 100, 6);
  });

  it("holds the shown value while the EMA moves within 2%", () => {
    const prev = estimator({
      prevC: 100,
      anchorU: 10,
      ema: 1000,
      display: 1000,
      baseline: 1000,
    });
    // recent 1030，EMA 走一半到 1015，只偏 1.5%
    const held = foldQuotaSample(prev, 110.3, 11);
    expect(held.ema).toBeCloseTo(1015, 6);
    expect(held.display).toBe(1000);

    // 再一格 $10.9/1pp：两段加权 recent ≈ 1066.8，EMA ≈ 1040.9，偏出 2%，显示值跟上
    const moved = foldQuotaSample(held, 121.2, 12);
    expect(moved.ema).toBeCloseTo(1040.9, 0);
    expect(moved.display).toBe(moved.ema);
  });

  it("estimates from the spans left after trimming", () => {
    // 加上新一格共 11pp，最旧那段 {1000, 1} 要丢。用裁剪后的段，斜率全是 $1000/pp。
    const prev = estimator({
      prevC: 100,
      anchorU: 20,
      spans: [
        { dC: 1000, dU: 1 },
        { dC: 90, dU: 9 },
      ],
    });
    const next = foldQuotaSample(prev, 110, 21);
    expect(next.spans).toEqual([
      { dC: 90, dU: 9 },
      { dC: 10, dU: 1 },
    ]);
    expect(next.ema).toBeCloseTo(1000, 6);
  });

  it("folds instants into the EMA with the previous EMA as the trend baseline", () => {
    const prev = estimator({
      prevC: 100,
      anchorU: 10,
      ema: 1000,
      display: 1000,
      baseline: 900,
    });
    const next = foldQuotaSample(prev, 130, 11); // recent 3000
    expect(next.baseline).toBe(1000);
    expect(next.ema).toBeCloseTo(2000, 6);
    expect(next.display).toBeCloseTo(2000, 6);
  });

  it("clears the spans but keeps the estimate when the window resets and C drops", () => {
    const prev = estimator({
      prevC: 300,
      anchorU: 30,
      pendingDC: 5,
      spans: [{ dC: 100, dU: 10 }],
      ema: 1000,
      display: 1000,
      baseline: 990,
    });
    const afterReset = foldQuotaSample(prev, 20, 2);
    expect(afterReset).toEqual(
      estimator({
        prevC: 20,
        anchorU: 2,
        ema: 1000,
        display: 1000,
        baseline: 990,
      }),
    );

    // 重置后的第一格只用重置后的花费
    const next = foldQuotaSample(afterReset, 220, 12);
    expect(next.spans).toEqual([{ dC: 200, dU: 10 }]);
  });

  it("ignores samples while C still carries the previous window's spend", () => {
    // 真实形状：窗口重置后 U 归零，C 却还是旧窗口的累计，C/U 冲到十万级。
    const prev = estimator({
      prevC: 1996,
      anchorU: 53,
      spans: [{ dC: 40, dU: 1 }],
      ema: 4000,
      display: 4000,
      baseline: 4000,
    });
    const staleStates = foldEach(prev, [
      [2031, 0],
      [2051, 0],
      [2086, 2],
      [2192, 3],
    ]);
    expect(staleStates[0]).toEqual(
      estimator({
        prevC: 1996,
        anchorU: 0,
        stale: { refC: 1996 },
        ema: 4000,
        display: 4000,
        baseline: 4000,
      }),
    );
    for (const state of staleStates.slice(1)) {
      expect(state).toEqual(staleStates[0]);
    }

    // C 跌破重置前的最后一个可信值：已改按新窗口量，从这里开新段
    const recovered = foldQuotaSample(lastOf(staleStates), 5, 4);
    expect(recovered).toEqual(
      estimator({
        prevC: 5,
        anchorU: 4,
        ema: 4000,
        display: 4000,
        baseline: 4000,
      }),
    );

    // 之后照常估算：recent = 100·60/1 = 6000，EMA 从 4000 走一半
    const resumed = foldQuotaSample(recovered, 65, 5);
    expect(resumed.spans).toEqual([{ dC: 60, dU: 1 }]);
    expect(resumed.display).toBeCloseTo(5000, 6);
  });

  it("only takes the cumulative bootstrap when provisional is allowed and nothing is estimated yet", () => {
    expect(foldQuotaSample(null, 100, 50).display).toBeNull();
    const provisional = foldQuotaSample(null, 100, 50, true);
    expect(provisional.display).toBeCloseTo(200, 6);

    // 已有 EMA 后不再走 provisional，等第一格
    const again = foldQuotaSample(provisional, 120, 50, true);
    expect(again.ema).toBeCloseTo(200, 6);
    expect(again.display).toBeCloseTo(200, 6);
  });

  it("skips the bootstrap when the state already carries an estimate", () => {
    const seeded = estimator({ ema: 1000, display: 1000, baseline: 1000 });
    const next = foldQuotaSample(seeded, 100, 50, true);
    expect(next).toEqual(
      estimator({
        prevC: 100,
        anchorU: 50,
        ema: 1000,
        display: 1000,
        baseline: 1000,
      }),
    );
  });

  it("keeps only the newest spans that still cover 10 percentage points", () => {
    const samples: Array<[number, number]> = [[100, 10]];
    for (let k = 1; k <= 20; k++) samples.push([100 + 10 * k, 10 + k]);
    const final = lastOf(foldEach(null, samples));
    expect(final.spans).toHaveLength(10);
    expect(final.spans.every((s) => s.dC === 10 && s.dU === 1)).toBe(true);
    expect(final.display).toBeCloseTo(1000, 6);
  });

  it("keeps the newest 64 spans", () => {
    // 第 k 格 U 涨 0.1、花 $k，100 格合计 10pp，覆盖规则一段都不丢，只有上限起作用
    const samples: Array<[number, number]> = [[100, 10]];
    let cost = 100;
    for (let k = 1; k <= 100; k++) {
      cost += k;
      samples.push([cost, 10 + k / 10]);
    }
    const final = lastOf(foldEach(null, samples));
    expect(final.spans).toHaveLength(64);
    expect(final.spans.map((span) => span.dC)).toEqual(
      Array.from({ length: 64 }, (_, i) => 37 + i),
    );
  });

  it("does not mutate the previous state", () => {
    const prev = estimator({
      prevC: 110,
      anchorU: 11,
      pendingDC: 3,
      spans: [{ dC: 10, dU: 1 }],
    });
    const snapshot = structuredClone(prev);
    foldQuotaSample(prev, 140, 12);
    foldQuotaSample(prev, 120, 11);
    expect(prev).toEqual(snapshot);
  });
});

describe("seededEstimator", () => {
  it("starts with no segment and the estimate at the seed", () => {
    expect(seededEstimator(1234)).toEqual(
      estimator({ ema: 1234, display: 1234, baseline: 1234 }),
    );
  });

  it("opens a segment on the next sample and keeps the seed", () => {
    const next = foldQuotaSample(seededEstimator(1000), 50, 10, true);
    expect(next).toEqual(
      estimator({
        prevC: 50,
        anchorU: 10,
        ema: 1000,
        display: 1000,
        baseline: 1000,
      }),
    );
  });
});

describe("startNewSegment", () => {
  it("returns null for a missing state", () => {
    expect(startNewSegment(null)).toBeNull();
  });

  it("clears the segment but keeps the estimate and the stale marker", () => {
    const prev = estimator({
      prevC: 300,
      anchorU: 30,
      pendingDC: 7,
      spans: [{ dC: 1, dU: 1 }],
      stale: { refC: 1996 },
      ema: 1000,
      display: 990,
      baseline: 980,
    });
    const snapshot = structuredClone(prev);
    const next = startNewSegment(prev);
    expect(next).toEqual(
      estimator({
        stale: { refC: 1996 },
        ema: 1000,
        display: 990,
        baseline: 980,
      }),
    );
    expect(next).not.toBe(prev);
    expect(prev).toEqual(snapshot);
  });

  it("makes the next sample open a segment instead of folding across the gap", () => {
    const prev = estimator({
      prevC: 300,
      anchorU: 30,
      spans: [{ dC: 100, dU: 10 }],
      ema: 1000,
      display: 1000,
      baseline: 1000,
    });
    const next = foldQuotaSample(startNewSegment(prev), 10, 45);
    expect(next).toEqual(
      estimator({
        prevC: 10,
        anchorU: 45,
        ema: 1000,
        display: 1000,
        baseline: 1000,
      }),
    );
  });
});
