import { useEffect, useRef, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { usageApi } from "@/lib/api/usage";
import { useQuotaHistory } from "@/lib/query/quotaHistory";
import type { QuotaTier, SubscriptionQuota } from "@/types/subscription";
import {
  classifyTrend,
  foldQuotaSample,
  isEstimableApp,
  PROVISIONAL_MIN_TOKENS,
  sumTierCost,
  tierWindowMs,
  tierWindowStartSec,
  type EstimableApp,
  type EstimatorState,
} from "./quotaEstimate";
import { hourIndex, latestTierEstimates } from "./quotaHistory";

const DAY_MS = 86_400_000;
const SEED_HISTORY_DAYS = 14;

export interface TierEstimate {
  tierName: string;
  /** Deadbanded, EMA-smoothed quota ($) for display; null until shown. */
  quotaUsd: number | null;
  utilization: number;
  trend: "up" | "down" | "flat" | null;
  loading: boolean;
}

interface TierAccum extends EstimatorState {
  /** The quota.queriedAt already folded, to avoid folding the same snapshot twice. */
  lastQueriedAt: number;
}

/** A state with no segment yet whose estimate starts at `seed`. */
function seededState(seed: number): EstimatorState {
  return {
    prevC: null,
    anchorU: null,
    pendingDC: 0,
    spans: [],
    stale: null,
    ema: seed,
    display: seed,
    baseline: seed,
  };
}

/**
 * Compute a quota estimate for every estimable tier of a SubscriptionQuota.
 *
 * Returns `Map<tierName, TierEstimate>`, containing only tiers with a known
 * window length and a reset time still in the future. The estimator state lives
 * in a ref and is dropped on unmount. On mount each tier starts from the latest
 * estimate in the last 14 days of quota history, when there is one; live
 * samples are not folded until that history query has settled.
 */
export function useQuotaEstimates(
  appId: string | undefined,
  quota: SubscriptionQuota | undefined,
): Map<string, TierEstimate> {
  const enabled = isEstimableApp(appId) && Boolean(quota?.success);
  const queriedAt = quota?.queriedAt ?? 0;
  const nowMs = Date.now();

  const tiers: QuotaTier[] = enabled ? (quota?.tiers ?? []) : [];
  const windows = tiers.flatMap((tier) => {
    const start = tierWindowStartSec(tier, nowMs);
    return start == null ? [] : [{ tier, start }];
  });

  const results = useQueries({
    queries: windows.map(({ tier, start }) => ({
      // queriedAt in the key: only recompute when the quota is re-fetched,
      // avoiding render churn. start in the key: bust the cache when the
      // window start changes so a stale result is not reused.
      queryKey: ["quotaEstimate", appId, tier.name, queriedAt, start] as const,
      queryFn: () =>
        usageApi.getModelStats(
          start,
          Math.floor(nowMs / 1000),
          appId as EstimableApp,
        ),
      enabled,
      staleTime: 5 * 60 * 1000,
    })),
  });

  // Provisional bootstrap gate: anchored on the 7-day window, using
  // cache-inclusive tokens (realTotalTokens) — get_model_stats.total_tokens
  // excludes cache reads/creation, which understates a heavy account by ~100x.
  const sevenDayStart =
    windows.find(({ tier }) => tierWindowMs(tier.name) === 7 * DAY_MS)?.start ??
    null;
  const sevenDaySummary = useQuery({
    queryKey: ["quotaEstimateTokens", appId, queriedAt, sevenDayStart],
    queryFn: () =>
      usageApi.getUsageSummary(
        sevenDayStart as number,
        Math.floor(Date.now() / 1000),
        appId as EstimableApp,
      ),
    enabled: enabled && sevenDayStart != null,
    staleTime: 5 * 60 * 1000,
  });
  const provisionalOK =
    (sevenDaySummary.data?.realTotalTokens ?? 0) >= PROVISIONAL_MIN_TOKENS;

  const history = useQuotaHistory(
    hourIndex(nowMs - SEED_HISTORY_DAYS * DAY_MS),
    hourIndex(nowMs),
    enabled,
  );

  const accumRef = useRef<Map<string, TierAccum>>(new Map());
  const [, bump] = useState(0);

  const settleSignature = results
    .map((r) => r.dataUpdatedAt)
    .concat(sevenDaySummary.dataUpdatedAt)
    .join(",");
  useEffect(() => {
    if (!enabled || !appId) return;
    // A record created before the history lands would never get its seed.
    if (history.isLoading) return;

    let seeds: Map<string, number> | undefined;
    const seedFor = (tierName: string) => {
      seeds ??= history.data
        ? latestTierEstimates(history.data, appId)
        : new Map<string, number>();
      return seeds.get(tierName);
    };

    let changed = false;
    windows.forEach(({ tier }, i) => {
      const rows = results[i]?.data;
      if (!rows) return;
      const C = sumTierCost(rows, tier.name);
      const U = tier.utilization;
      if (!(C > 0) || !(U > 0)) return; // nothing measurable yet

      const key = `${appId}:${tier.name}`;
      const rec = accumRef.current.get(key);
      if (rec && rec.lastQueriedAt === queriedAt) return; // already folded

      const seed = rec ? undefined : seedFor(tier.name);
      const start = rec ?? (seed != null ? seededState(seed) : null);
      // `provisionalOK` is shared across tiers so 5h and 7d appear together.
      accumRef.current.set(key, {
        ...foldQuotaSample(start, C, U, provisionalOK),
        lastQueriedAt: queriedAt,
      });
      changed = true;
    });
    if (changed) bump((v) => v + 1);
    // settleSignature covers result-data changes; queriedAt covers snapshot
    // rotation; history.isLoading releases the first fold.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, appId, queriedAt, settleSignature, history.isLoading]);

  const estimates = new Map<string, TierEstimate>();
  windows.forEach(({ tier }, i) => {
    const rec = accumRef.current.get(`${appId}:${tier.name}`);
    estimates.set(tier.name, {
      tierName: tier.name,
      quotaUsd: rec?.display ?? null,
      utilization: tier.utilization,
      trend: rec?.ema != null ? classifyTrend(rec.baseline, rec.ema) : null,
      loading: results[i]?.isLoading ?? false,
    });
  });

  return estimates;
}
