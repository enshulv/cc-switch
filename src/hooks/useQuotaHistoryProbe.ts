/**
 * Hourly subscription-quota probe (additive — no upstream data-flow changes).
 *
 * The quota footer already fetches `get_subscription_quota`, but only while a
 * provider card for the current app is on screen, and it keeps nothing: once a
 * window rolls over its previous utilization is unrecoverable. This hook keeps
 * one long-lived observer per quota-capable app so a reading lands at least
 * once an hour, and persists each one through `record_quota_history`.
 *
 * It deliberately reuses `subscriptionKeys.quota(appId)` — the SAME react-query
 * key as the footer — so the two share a single in-flight request and cache
 * entry. While a card is visible the footer's 5-minute poll drives the fetches
 * and this hook costs nothing extra; when nothing is on screen the hourly timer
 * here takes over. The backend upserts per measured hour, so those extra
 * refreshes only sharpen the sample rather than duplicating rows.
 *
 * Apps whose credentials are absent short-circuit in the backend without a
 * network call, so probing a not-logged-in app is effectively free.
 */
import { useEffect, useRef } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { subscriptionApi } from "@/lib/api/subscription";
import { quotaHistoryApi } from "@/lib/api/quotaHistory";
import { usageApi } from "@/lib/api/usage";
import { subscriptionKeys } from "@/lib/query/subscription";
import { quotaHistoryKeys } from "@/lib/query/quotaHistory";
import type { AppId } from "@/lib/api/types";
import type { SubscriptionQuota } from "@/types/subscription";
import type { VisibleApps } from "@/types";
import {
  hourIndex,
  toQuotaSamples,
  type TierSpendMap,
} from "@/components/usage/quotaHistory";
import {
  isEstimableApp,
  sumTierCost,
  tierWindowStartSec,
} from "@/components/usage/quotaEstimate";

/** Apps `get_subscription_quota` supports (mirrors `useSubscriptionQuota`). */
export const PROBE_APPS = [
  "claude",
  "codex",
  "gemini",
] as const satisfies readonly AppId[];

export const PROBE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * 量出每个窗口内本机实测的美元消耗 C，与厂商给的百分比 U 配对入库。
 *
 * 窗口区间与求和口径都复用 `quotaEstimate` 的 `tierWindowStartSec` / `sumTierCost`——
 * 和页脚实时估算量的是同一段区间、同一批模型，否则两边的数会对不上。只有 Claude / Codex
 * 能反推额度（`isEstimableApp`），其余应用返回空表、`spendUsd` 落 null，图上就没有曲线。
 * `getModelStats` 读的是本地库，一次调用很便宜；每个窗口一次，每小时一轮。
 */
async function measureTierSpend(
  appId: string,
  quota: SubscriptionQuota | undefined,
): Promise<TierSpendMap> {
  if (!isEstimableApp(appId) || !quota?.success) return {};

  const spend: TierSpendMap = {};
  const end = Math.floor(Date.now() / 1000);
  for (const tier of quota.tiers ?? []) {
    const start = tierWindowStartSec(tier);
    if (start == null) continue;
    try {
      const rows = await usageApi.getModelStats(start, end, appId);
      spend[tier.name] = sumTierCost(rows, tier.name);
    } catch (error) {
      // 量不到就当没量到，这个小时的美元额度留空，不影响百分比入库。
      console.warn("[quotaHistoryProbe] failed to measure window spend", error);
    }
  }
  return spend;
}

export interface UseQuotaHistoryProbeOptions {
  /** Skip apps the user has hidden; when omitted every probe app is polled. */
  visibleApps?: Partial<VisibleApps>;
  enabled?: boolean;
}

export function useQuotaHistoryProbe({
  visibleApps,
  enabled = true,
}: UseQuotaHistoryProbeOptions = {}) {
  const queryClient = useQueryClient();

  // Fixed-length query list (enabled per app) keeps the observer set stable
  // across visibility changes instead of tearing observers down and up.
  const results = useQueries({
    queries: PROBE_APPS.map((appId) => ({
      queryKey: subscriptionKeys.quota(appId),
      queryFn: () => subscriptionApi.getQuota(appId),
      enabled: enabled && (visibleApps ? visibleApps[appId] !== false : true),
      refetchInterval: PROBE_INTERVAL_MS,
      refetchIntervalInBackground: true,
      staleTime: PROBE_INTERVAL_MS,
      retry: 1,
    })),
  });

  // `dataUpdatedAt` changes on every settled fetch, including a re-fetch that
  // returns the same numbers.
  const settleSignature = results.map((r) => r.dataUpdatedAt).join(",");
  // Throttle to one measurement per app per MEASURED HOUR — the rate this probe
  // actually claims to run at.
  //
  // Two multipliers would otherwise stack. The effect keys on all three apps'
  // `dataUpdatedAt`, so it re-runs ~3× per poll cycle; and while the footer is on
  // screen the shared query refetches every 5 min, giving 12 fresh readings an
  // hour. Re-measuring on each would be ~180 `getModelStats` aggregations an hour
  // (each potentially scanning a 30-day range, and bypassing react-query so
  // nothing is deduped or cached) for a row that is only ever stored once per
  // hour anyway.
  //
  // Keying on the hour bucket costs nothing real: C is cumulative WITHIN the
  // window, so sampling at :05 instead of :55 shifts spend attribution between
  // two adjacent hours but never loses it — ΣΔC telescopes either way.
  const lastMeasuredHourRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const persist = async () => {
      let recorded = false;
      for (const [index, appId] of PROBE_APPS.entries()) {
        if (cancelled) return;
        const quota = results[index]?.data;
        const measuredAt = quota?.queriedAt ?? null;
        if (measuredAt == null) continue;
        const measuredHour = hourIndex(measuredAt);
        if (lastMeasuredHourRef.current.get(appId) === measuredHour) continue;

        const spend = await measureTierSpend(appId, quota);
        if (cancelled) return;
        const sample = toQuotaSamples(quota, Date.now(), spend);
        if (!sample) continue;
        try {
          const changed = await quotaHistoryApi.record(
            appId,
            sample.measuredAt,
            sample.tiers,
          );
          lastMeasuredHourRef.current.set(appId, measuredHour);
          recorded = recorded || changed;
        } catch (error) {
          // A failed write costs one hourly sample; never break the app over it.
          console.warn("[quotaHistoryProbe] failed to record quota", error);
        }
      }
      if (recorded && !cancelled) {
        queryClient.invalidateQueries({ queryKey: quotaHistoryKeys.all });
      }
    };

    void persist();
    return () => {
      cancelled = true;
    };
    // settleSignature stands in for the results array, which is a new object
    // on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, settleSignature]);
}
