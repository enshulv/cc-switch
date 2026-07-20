import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { SubscriptionQuota } from "@/types/subscription";
import { useMoneyFormat } from "@/hooks/useMoneyFormat";
import { useQuotaEstimates } from "@/components/usage/quotaEstimate";

/**
 * Fork-only: the reverse-computed dollar quota per window, rendered as one
 * muted line under the card's quota column ("Est. quota 5h $180 · Weekly $1234").
 *
 * Kept in its own file and exposed as a hook so the upstream-owned
 * `SubscriptionQuotaView` only needs two touch points (call + render), which
 * keeps the fork's rebases onto upstream cheap. The hook must run on every
 * render of the view (not only in the success branch) so the estimator's
 * accumulated deltas survive a transient failed refresh.
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
    label: (tierName: string) => string;
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
      return usd == null ? [] : [`${label(tier.name)} ${money(usd, 0)}`];
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
