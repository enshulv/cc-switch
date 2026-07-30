/**
 * 额度历史的纯逻辑层（fork 附加功能）。
 *
 * 持久化在后端：SQLite `~/.cc-switch/cc-switch.db` 的 `fork_quota_history` 表
 * （见 `src-tauri/src/database/dao/quota_history.rs`，惰性建表、不进迁移链）。
 * 这里只做两件不需要碰 IO 的事：
 *
 * 1. 把一份实时 `SubscriptionQuota` 读数（配上各窗口的本机实测消耗）抽成可入库的样本；
 * 2. 把后端返回的扁平行**回放**成美元额度曲线。
 *
 * ## 为什么存原料而不是存显示值
 *
 * 页脚显示的 `额度 $xxxx est.` 来自 [`quotaEstimate.ts`](./quotaEstimate.ts)，其状态活在一个
 * React ref 里——卸载即丢、重开重新收敛，而且只在 provider 卡片挂载时才计算。想「每小时把那个
 * 数字存下来」行不通：多数时刻它根本不存在。
 *
 * 所以入库的是**原料**：窗口已用百分比 U（账号级，厂商给）与本机实测消耗 C（`getModelStats`）。
 * 读取时用 quotaEstimate 里那几个纯函数在历史序列上回放，得出每个采样点的美元额度。好处是
 * 算法以后改了历史原料还能重算、估算值跨重启存活、且能回溯出完整曲线而不是从「预热完成」才开始。
 */
import type { SubscriptionQuota } from "@/types/subscription";
import type { QuotaHistoryRow, QuotaTierSample } from "@/lib/api/quotaHistory";
import { foldQuotaSample, type EstimatorState } from "./quotaEstimate";

const HOUR_MS = 3_600_000;

/** 相邻样本超过这个小时数就画成断线 */
export const DEFAULT_GAP_HOURS = 2;

/** 毫秒时间戳 → 纪元小时序号 */
export function hourIndex(ms: number): number {
  return Math.floor(ms / HOUR_MS);
}

/** 纪元小时序号 → 该小时起点的毫秒时间戳 */
export function hourStartMs(hour: number): number {
  return hour * HOUR_MS;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 各窗口的本机实测消耗，键为 tier 名；探针在落库前算好传进来 */
export type TierSpendMap = Record<string, number | null | undefined>;

/**
 * 从一份实时读数抽出可入库的样本。
 *
 * 返回 null 表示不值得记录：查询失败、没凭据、或没有任何可用窗口。
 * `measuredAt` 用 `queriedAt`（读数的**测量**时间）而不是当前时间——按测量时间分桶，
 * 重复观察到同一份缓存快照才是幂等的，不会把陈旧读数抹到后续每个小时。
 */
export function toQuotaSamples(
  quota: SubscriptionQuota | undefined,
  nowMs: number,
  spendByTier: TierSpendMap = {},
): { measuredAt: number; tiers: QuotaTierSample[] } | null {
  if (!quota?.success) return null;
  const measuredAt = quota.queriedAt ?? nowMs;
  if (!Number.isFinite(measuredAt)) return null;

  const tiers: QuotaTierSample[] = [];
  for (const tier of quota.tiers ?? []) {
    const utilization = finiteOrNull(tier?.utilization);
    if (!tier?.name || utilization == null || utilization < 0) continue;
    tiers.push({
      name: tier.name,
      utilization,
      usedUsd: finiteOrNull(tier.usedValueUsd),
      maxUsd: finiteOrNull(tier.maxValueUsd),
      spendUsd: finiteOrNull(spendByTier[tier.name]),
    });
  }
  if (tiers.length === 0) return null;

  return { measuredAt, tiers };
}

/** 图表的一行：ts + 每个窗口的美元额度（null 代表断档或尚未收敛） */
export interface QuotaSeriesRow {
  ts: number;
  [key: string]: number | null;
}

/** 该窗口在该时刻的已用百分比，仅供 tooltip */
export function utilKey(tier: string): string {
  return `${tier}__util`;
}

export interface QuotaSeries {
  /** 该区间内出现过的窗口名，按首次出现顺序 */
  tiers: string[];
  rows: QuotaSeriesRow[];
  /** 有原料但一个点都没收敛出来时为 true——「还在预热」，继续用就会出数 */
  warmingUp: boolean;
  /** 区间内是否存在可用于反推的原料；false 表示这些数据**永远**算不出美元额度 */
  estimable: boolean;
}

/**
 * 在一个窗口的历史序列上回放估算器，逐点得出美元额度。
 *
 * 每一步都调 `foldQuotaSample`——和页脚的实时 hook 是**同一个函数**，所以两边用的是同一套
 * 算法（增量斜率为主、累积作下界、EMA + 死区）。但**不等于两边数字时刻相同**：这个 fold 带
 * 状态且按样本推进，而页脚约 5 分钟一个样本、历史是 1 小时一个，EMA 的记忆长度因此差一个
 * 数量级（约 40 分钟 vs 约 8 小时）。额度刚变动时页脚先动、曲线后跟，是预期行为。
 *
 * 返回值与输入样本一一对应；`null` 表示该点还没攒够窗口移动量，尚未收敛。历史回放不开
 * provisional 引导（那条路径偏低），宁可先不出数。
 */
export function replayTierEstimates(
  samples: Array<{ u: number; c: number | null }>,
): Array<number | null> {
  let state: EstimatorState | null = null;
  const out: Array<number | null> = [];

  for (const { u, c } of samples) {
    // 没有实测消耗（老版本落的行）就无法参与估算，但仍占一个点位。
    if (c == null || !(c > 0) || !(u > 0)) {
      out.push(state?.display ?? null);
      continue;
    }
    state = foldQuotaSample(state, c, u);
    out.push(state.display);
  }

  return out;
}

/**
 * 把后端的扁平行组装成图表数据：每个窗口一条美元额度曲线，百分比随行带上供 tooltip 用。
 *
 * 应用关着的时段没有样本，这种断档会插入一个全 null 的点，让线真的断开——否则 recharts 会在
 * 相隔几天的两点间画一条直线，把「没测量」显示成「测量到没变化」。
 */
export function rowsToSeries(
  rows: QuotaHistoryRow[],
  appId: string,
  gapHours: number = DEFAULT_GAP_HOURS,
): QuotaSeries {
  // tier → 小时 → 该小时的行
  const byTier = new Map<string, Map<number, QuotaHistoryRow>>();
  const hourSet = new Set<number>();
  for (const row of rows) {
    if (row.appId !== appId) continue;
    hourSet.add(row.hour);
    let bucket = byTier.get(row.tier);
    if (!bucket) {
      bucket = new Map();
      byTier.set(row.tier, bucket);
    }
    bucket.set(row.hour, row);
  }

  const tiers = Array.from(byTier.keys());
  const hours = Array.from(hourSet).sort((a, b) => a - b);
  if (hours.length === 0)
    return { tiers: [], rows: [], warmingUp: false, estimable: false };

  // 逐窗口回放，得到「小时 → 美元额度」。
  //
  // 断档处必须**重置估算器**，不能把断档两侧当作相邻样本折进同一段累加：C 的口径是
  // 「本窗口内的消耗」，窗口一重置它就归零，所以跨窗口的 ΔC 根本不在同一根轴上。
  // 而窗口是否重置过，历史里无从判断（`resetsAt` 没入库，`dU < -RESET_DROP_PCT` 那条
  // 启发只在使用率**下降**时才触发）。举例：5h 窗口真实额度 $200，停机前 U=25/C=$10，
  // 停机期间窗口滚了两轮，重开后 U=45/C=$90——dU=+20 不降反升，检测不到重置，
  // 斜率算成 100·80/20 = $400，翻倍，而且这个坏样本会被 EMA 永久吸收。
  // 所以只要不连续就断开重来：门槛与视觉断线一致，代价只是重新预热（门槛才 2pp，很快）。
  const estimateByTier = new Map<string, Map<number, number | null>>();
  for (const tier of tiers) {
    const bucket = byTier.get(tier)!;
    const tierHours = Array.from(bucket.keys()).sort((a, b) => a - b);
    const estimates = new Map<number, number | null>();
    let segment: Array<{ u: number; c: number | null }> = [];
    let segmentHours: number[] = [];

    const flush = () => {
      const replayed = replayTierEstimates(segment);
      segmentHours.forEach((h, i) => estimates.set(h, replayed[i]));
      segment = [];
      segmentHours = [];
    };

    let prev: number | null = null;
    for (const h of tierHours) {
      if (prev != null && h - prev > gapHours) flush();
      segment.push({
        u: bucket.get(h)!.utilization,
        c: bucket.get(h)!.spendUsd,
      });
      segmentHours.push(h);
      prev = h;
    }
    flush();
    estimateByTier.set(tier, estimates);
  }

  const seriesRows: QuotaSeriesRow[] = [];
  let prevHour: number | null = null;
  let anyEstimate = false;
  // 有原料才谈得上「还在预热」：一份 spendUsd 都没有的区间（Gemini 这类无窗口长度的
  // 应用，或 v3.19.6 那版落的老行）是**永远算不出来**的，不能拿预热文案糊弄。
  let anySpend = false;

  const blankRow = (ts: number): QuotaSeriesRow => {
    // 断档行也要把每个 tier 显式写成 null。少写的话该键是 undefined，
    // QuotaSeriesRow 的类型签名就成了谎话，断线也只是碰巧生效。
    const row: QuotaSeriesRow = { ts };
    for (const tier of tiers) {
      row[tier] = null;
      row[utilKey(tier)] = null;
    }
    return row;
  };

  for (const hour of hours) {
    if (prevHour != null && hour - prevHour > gapHours) {
      seriesRows.push(blankRow(hourStartMs(prevHour + 1)));
    }
    const row: QuotaSeriesRow = { ts: hourStartMs(hour) };
    for (const tier of tiers) {
      const sample = byTier.get(tier)!.get(hour);
      // 该窗口这个小时没数据时必须是显式 null，否则 recharts 会把上一个点平推过去。
      const estimate = sample
        ? (estimateByTier.get(tier)!.get(hour) ?? null)
        : null;
      row[tier] = estimate;
      row[utilKey(tier)] = sample ? sample.utilization : null;
      if (estimate != null) anyEstimate = true;
      if (sample?.spendUsd != null) anySpend = true;
    }
    seriesRows.push(row);
    prevHour = hour;
  }

  return {
    tiers,
    rows: seriesRows,
    warmingUp: anySpend && !anyEstimate,
    estimable: anySpend,
  };
}

/** 按给定优先级挑出有数据的应用 */
export function appsWithHistory(
  rows: QuotaHistoryRow[],
  candidates: readonly string[],
): string[] {
  const present = new Set(rows.map((row) => row.appId));
  return candidates.filter((appId) => present.has(appId));
}
