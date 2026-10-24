/**
 * Quota-trend chart (additive — reads only what the hourly probe recorded).
 *
 * Plots the reverse-computed dollar quota of each subscription window (5h / 7d
 * / ...) over the dashboard's selected date range, so a window that has long
 * since reset can still be reviewed after the fact. Rows come from the
 * `fork_quota_history` table via `useQuotaHistory` and are replayed through the
 * estimator in `quotaHistory.ts`; the probe invalidates that query whenever a
 * reading adds something new.
 *
 * Rendered as its own panel under the usage overview (v4 dashboard); it no
 * longer shares a slot with the usage chart, so upstream's chart stays as is.
 */
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { History, Loader2 } from "lucide-react";
import { resolveUsageRange } from "@/lib/usageRange";
import type { UsageRangeSelection } from "@/types/usage";
import { TIER_I18N_KEYS } from "@/components/SubscriptionQuotaFooter";
import { PROBE_APPS } from "@/hooks/useQuotaHistoryProbe";
import { useQuotaHistory } from "@/lib/query/quotaHistory";
import { useMoneyFormat } from "@/hooks/useMoneyFormat";
import { getLocaleFromLanguage } from "./format";
import {
  appsWithHistory,
  hourIndex,
  rowsToSeries,
  utilKey,
} from "./quotaHistory";

interface QuotaTrendChartProps {
  range: UsageRangeSelection;
  /** Dashboard app filter; "all" falls back to the first app with history. */
  appType?: string;
}

/** Same axis style as upstream's UsageTrendChart. */
const AXIS_TICK = { fill: "var(--text-3)", fontSize: 11 };

/** Stable per-window colors, aligned with the usage chart's palette. */
const TIER_COLORS: Record<string, string> = {
  five_hour: "#3b82f6",
  seven_day: "#22c55e",
  seven_day_opus: "#f97316",
  seven_day_sonnet: "#a855f7",
  weekly_limit: "#22c55e",
  "30_day": "#eab308",
  monthly: "#eab308",
  premium: "#14b8a6",
};
const FALLBACK_COLORS = ["#f43f5e", "#0ea5e9", "#84cc16", "#d946ef"];

function tierColor(tier: string, index: number): string {
  return TIER_COLORS[tier] ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length];
}

export function QuotaTrendChart({ range, appType }: QuotaTrendChartProps) {
  const { t, i18n } = useTranslation();
  const { money } = useMoneyFormat();

  const { startDate, endDate } = resolveUsageRange(range);
  const language = i18n.resolvedLanguage || i18n.language || "en";
  const locale = getLocaleFromLanguage(language);

  // Quantize to hours: the range end is "now", so a second-resolution query key
  // would change on every render and refetch forever.
  const startHour = hourIndex(startDate * 1000);
  const endHour = hourIndex(endDate * 1000);
  const { data: history, isLoading } = useQuotaHistory(startHour, endHour);

  // "all" has no single subject: show the first quota-capable app that has
  // actually recorded something (claude → codex → gemini).
  const appId = useMemo(() => {
    if (appType && appType !== "all") return appType;
    return appsWithHistory(history ?? [], PROBE_APPS)[0] ?? PROBE_APPS[0];
  }, [appType, history]);

  const { tiers, rows, warmingUp, estimable } = useMemo(
    () => rowsToSeries(history ?? [], appId),
    [history, appId],
  );

  const spansOneDay = endDate - startDate <= 36 * 60 * 60;
  const formatTs = (ts: number) =>
    new Date(ts).toLocaleString(
      locale,
      spansOneDay
        ? {
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          }
        : { month: "2-digit", day: "2-digit", hour: "2-digit" },
    );

  const tierLabel = (tier: string) =>
    TIER_I18N_KEYS[tier] ? t(TIER_I18N_KEYS[tier]) : tier;

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null;
    const row = payload[0]?.payload ?? {};
    return (
      <div className="rounded-[8px] border border-border bg-surface px-3 py-2 text-caption text-fg-1 shadow-v7-md">
        <p className="mb-1 font-semibold">{formatTs(label)}</p>
        {payload.map((entry: any, index: number) => {
          if (entry.value == null) return null;
          const util = row[utilKey(entry.dataKey)];
          return (
            <div key={index} className="flex items-center gap-2 tabular-nums">
              <span
                aria-hidden="true"
                className="h-2 w-2 rounded-[2px]"
                style={{ backgroundColor: entry.color }}
              />
              <span className="text-fg-2">{entry.name}</span>
              <span className="ms-auto ps-3">{money(entry.value, 0)}</span>
              {util != null && (
                <span className="text-fg-3">({util.toFixed(1)}%)</span>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <section
      aria-labelledby="quota-trend-title"
      className="shrink-0 overflow-hidden rounded-panel border border-border bg-surface px-4 pb-2.5 pt-3"
    >
      <div className="flex min-h-7 items-center justify-between gap-3">
        <h2
          id="quota-trend-title"
          className="m-0 whitespace-nowrap text-caption font-semibold leading-7 text-fg-2"
        >
          {t("usage.quotaTrends", "额度趋势")}
        </h2>
        <span className="text-caption uppercase tracking-wide text-fg-3">
          {appId}
        </span>
      </div>

      <div className="mt-1 h-[180px] w-full">
        {isLoading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-fg-3" />
          </div>
        ) : tiers.length === 0 || !estimable || warmingUp ? (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 text-center">
            <History className="h-5 w-5 text-fg-3" strokeWidth={1.5} />
            <p className="m-0 text-body text-fg-2">
              {/* 三态必须分开：「没记录」还能等，「算不出」等一辈子也没用。 */}
              {tiers.length === 0
                ? t("usage.quotaTrendEmpty", "该区间暂无额度记录")
                : !estimable
                  ? t(
                      "usage.quotaTrendNotEstimable",
                      "该区间的记录无法反推额度",
                    )
                  : t("usage.quotaTrendWarmingUp", "额度估算尚未收敛")}
            </p>
            <p className="m-0 max-w-md text-caption text-fg-3">
              {tiers.length === 0
                ? t(
                    "usage.quotaTrendHint",
                    "额度探针每小时记录一次订阅窗口用量，保持应用运行即可逐步累积历史。",
                  )
                : !estimable
                  ? t(
                      "usage.quotaTrendNotEstimableHint",
                      "反推额度需要本机实测消耗，目前仅 Claude 与 Codex 的固定窗口支持；旧版本记录的数据也缺少这项，无法补算。",
                    )
                  : t(
                      "usage.quotaTrendWarmingUpHint",
                      "额度靠「本机实测消耗 ÷ 已用百分比」反推，需要观察到足够的窗口移动量才出数。继续用一段时间即可。",
                    )}
            </p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={rows}
              margin={{ top: 6, right: 0, left: 0, bottom: 0 }}
            >
              <CartesianGrid
                vertical={false}
                stroke="var(--chart-grid)"
                strokeWidth={1}
              />
              <XAxis
                dataKey="ts"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                axisLine={false}
                tickLine={false}
                tick={AXIS_TICK}
                tickMargin={6}
                minTickGap={48}
                tickFormatter={formatTs}
              />
              <YAxis
                width="auto"
                axisLine={false}
                tickLine={false}
                tick={AXIS_TICK}
                tickCount={3}
                tickFormatter={(value) => money(value, 0)}
              />
              <Tooltip
                content={<CustomTooltip />}
                cursor={{ stroke: "var(--text-3)", strokeDasharray: "3 3" }}
              />
              <Legend
                iconType="plainline"
                wrapperStyle={{ fontSize: 11, color: "var(--text-2)" }}
              />
              {tiers.map((tier, index) => (
                <Line
                  key={tier}
                  type="monotone"
                  dataKey={tier}
                  name={tierLabel(tier)}
                  stroke={tierColor(tier, index)}
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                  // Gaps are real (app closed): never bridge them with a
                  // straight line that would read as steady usage.
                  connectNulls={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </section>
  );
}
