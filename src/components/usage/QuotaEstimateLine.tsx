import type { ReactNode } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { SubscriptionQuota } from "@/types/subscription";
import { useMoneyFormat } from "@/hooks/useMoneyFormat";
import { useQuotaEstimates } from "@/components/usage/quotaEstimate";

/**
 * Fork-only: the reverse-computed dollar quota per window, rendered as one
 * muted line under the card's quota column ("Est. quota 5h $180 · Weekly $1234").
 *
 * Kept in its own file so the upstream-owned quota components need only small
 * touch points, which keeps the fork's rebases onto upstream cheap. The thin
 * footer wrappers call this hook (they are always mounted and already sit under
 * a QueryClient) and hand the node to `SubscriptionQuotaView` as a prop; the
 * view itself stays hook-free, so upstream tests that render it bare still
 * pass, and the estimator's accumulated deltas survive a failed refresh.
 *
 * Returns null until at least one window's estimate has passed its gate, and
 * always for apps other than Claude / Codex.
 */
export function useQuotaEstimateLine(
  appId: string | undefined,
  quota: SubscriptionQuota | undefined,
  {
    label,
    hidden,
  }: {
    /** Short window name for a tier ("5h" / "Weekly"). */
    label: (t: TFunction, tierName: string) => string;
    /** Tiers the card column hides; their estimate is not shown either. */
    hidden?: ReadonlySet<string>;
  },
): ReactNode {
  const { t } = useTranslation();
  const { money } = useMoneyFormat();
  const estimates = useQuotaEstimates(appId, quota);

  const parts = (quota?.tiers ?? [])
    .filter((tier) => !hidden?.has(tier.name))
    .flatMap((tier) => {
      const usd = estimates.get(tier.name)?.quotaUsd;
      return usd == null ? [] : [`${label(t, tier.name)} ${money(usd, 0)}`];
    });
  if (parts.length === 0) return null;

  const text = t("subscription.estQuota", {
    value: parts.join(" · "),
    defaultValue: "Est. quota {{value}}",
  });
  return (
    <span
      className="max-w-full truncate text-[10px] leading-[14px] text-fg-3 tabular-nums"
      title={text}
    >
      {text}
    </span>
  );
}
