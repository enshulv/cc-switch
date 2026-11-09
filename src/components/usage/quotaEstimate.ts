/**
 * Quota-estimate algorithm (pure, no IO, no upstream logic changes).
 *
 * Providers only expose a used-percentage per subscription window
 * (`QuotaTier.utilization`), never an absolute quota. cc-switch already derives
 * the real dollar spend for each window from local session files
 * (`getModelStats(start, now, appType)`), so we can reverse-compute the
 * window's total dollar value Q ≈ 100·ΔC/ΔU.
 *
 * `utilization` (U) is ACCOUNT-wide — it counts every surface on the account
 * (this device, other machines, claude.ai chat, ...) — while the local spend
 * (C) only covers what this install recorded. U is also reported as a whole
 * number, so most refreshes see it unchanged while C keeps rising.
 *
 * The estimator therefore works in SPANS: local spend accumulates while U sits
 * still, and each time U steps up the accumulated spend is settled together
 * with the size of the step. The estimate is a recency-weighted slope over the
 * last few percentage points of spans (`RECENCY_HALF_LIFE_PP`), so it follows
 * the current usage mix quickly and corrects itself as more steps arrive.
 * Spans driven by other machines read low; they are kept as-is. The cumulative
 * ratio `100·C/U` acts as a floor (all local data is a lower bound the true
 * quota can't fall below).
 *
 * Q is an account-level dollar figure, independent of any one window, so the
 * estimate survives window resets and recording gaps; only the span state is
 * cleared there (`startNewSegment`).
 *
 * The live hook (`useQuotaEstimates`) streams refreshes through
 * `foldQuotaSample`, and `quotaHistory.replayTierEstimates` replays the hourly
 * persisted (C, U) series through the same step to draw the quota-trend chart.
 */
import type { ModelStats } from "@/types/usage";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * ── Tuning knobs ──────────────────────────────────────────────────────────
 * These trade responsiveness against stability. C (local spend) and U
 * (provider percentage) come from two unsynchronized sources, and U moves in
 * whole percentage points. This is a single-user personal fork, so the tuning
 * is deliberately biased toward **converging fast**, accepting jumpier
 * readings that later samples correct. Each knob can be adjusted in isolation:
 *
 * - RECENCY_HALF_LIFE_PP — a span's weight halves for every this-many
 *   percentage points of newer spans. At 1.5 the last 1–2 points dominate the
 *   estimate.
 * - SPAN_KEEP_PP / MAX_SPANS — how much span history is kept. At 10 points of
 *   age a span weighs about 1%, so older spans cannot move the estimate
 *   visibly.
 * - RESET_DROP_PCT — a utilization drop larger than this is treated as a window
 *   reset: the spans are cleared, the estimate is kept. A smaller drop counts
 *   as a reset only when C falls with it.
 * - EMA_ALPHA — smoothing weight of each new sample (0..1). Higher = snappier
 *   but jumpier; lower = steadier but slower. Residual error after n samples is
 *   (1−α)^n, so at α=0.5 five samples leave ~3%. The footer refreshes every
 *   5 min and the history chart samples hourly, so the footer converges in
 *   minutes and the chart in hours.
 * - DISPLAY_DEADBAND_RATIO — hysteresis on the shown number. Hold the last
 *   figure until the EMA drifts past this fraction, then snap to it.
 * - TREND_EPS_RATIO — dead zone for the trend arrow. Moves within this fraction
 *   of the baseline read as "flat" instead of up/down.
 * - PROVISIONAL_MIN_TOKENS — bootstrap gate, measured on the 7-day window using
 *   cache-inclusive tokens (realTotalTokens; input + output + cache read +
 *   cache creation). Before the first span settles, if that window already
 *   holds enough local token history, show the direct (cumulative) inference
 *   immediately instead of hiding. The one decision is shared across all tiers
 *   so 5h and 7d light up together.
 */
export const RECENCY_HALF_LIFE_PP = 1.5;
const SPAN_KEEP_PP = 10;
const MAX_SPANS = 64;
export const RESET_DROP_PCT = 20;
const EMA_ALPHA = 0.5;
const DISPLAY_DEADBAND_RATIO = 0.02;
const TREND_EPS_RATIO = 0.08;
export const PROVISIONAL_MIN_TOKENS = 500_000_000;

/** Only Claude / Codex are supported (other providers are out of scope for now). */
export type EstimableApp = "claude" | "codex";

export function isEstimableApp(
  appId: string | undefined,
): appId is EstimableApp {
  return appId === "claude" || appId === "codex";
}

/**
 * Infer a window length (ms) from the tier name. The window start is
 * `resetsAt - windowLength`, so this needs no backend `limit_window_seconds`
 * and stays purely front-end. Unknown windows return null (skip estimation).
 */
export function tierWindowMs(name: string): number | null {
  switch (name) {
    case "five_hour":
      return 5 * HOUR_MS;
    case "seven_day":
    case "seven_day_opus":
    case "seven_day_sonnet":
    case "weekly_limit":
      return 7 * DAY_MS;
    case "30_day":
    case "monthly":
      return 30 * DAY_MS;
    default:
      return null;
  }
}

/**
 * Which models feed a tier's numerator.
 *
 * Claude's 7-day window is split into per-model tiers (`seven_day_opus` /
 * `seven_day_sonnet`), each with its own utilization, so those track a single
 * model group. Shared windows (five_hour / seven_day / all Codex windows) sum
 * every model. Depends on the model-name string (containing "opus" / "sonnet")
 * — the loose match tolerates future naming.
 */
export function tierModelPredicate(name: string): (model: string) => boolean {
  if (name === "seven_day_opus") return (m) => /opus/i.test(m);
  if (name === "seven_day_sonnet") return (m) => /sonnet/i.test(m);
  return () => true;
}

function sumCost(rows: ModelStats[], pred: (m: string) => boolean): number {
  return rows
    .filter((r) => pred(r.model))
    .reduce((acc, r) => acc + (Number.parseFloat(r.totalCost) || 0), 0);
}

/** Local spend feeding one tier's numerator, in dollars. */
export function sumTierCost(rows: ModelStats[], tierName: string): number {
  return sumCost(rows, tierModelPredicate(tierName));
}

/**
 * Window start as Unix **seconds** (`resetsAt − window length`), or null when
 * the tier has no known window, no reset time, or a reset time at or before
 * `nowMs`. A past `resetsAt` belongs to a window that has already rolled over,
 * so the current window's start is unknown.
 *
 * `get_model_stats` takes seconds (see `resolveUsageRange`); passing millis
 * pushes the range into the future and returns no spend, so the numerator
 * silently becomes 0. Shared by the live hook and the hourly history probe so
 * both measure the exact same interval.
 */
export function tierWindowStartSec(
  tier: { name: string; resetsAt: string | null },
  nowMs: number = Date.now(),
): number | null {
  const windowMs = tierWindowMs(tier.name);
  if (windowMs == null || !tier.resetsAt) return null;
  const resetsMs = new Date(tier.resetsAt).getTime();
  if (!Number.isFinite(resetsMs) || resetsMs <= nowMs) return null;
  return Math.floor((resetsMs - windowMs) / 1000);
}

/**
 * Cumulative lower-bound estimate: 100 · spend ÷ percentage over all local
 * data in the window. Biased low when the account is used off this device, so
 * it only ever serves as a floor. Null when spend or percentage is non-positive.
 */
export function cumulativeQuotaUsd(
  costUsd: number,
  utilization: number,
): number | null {
  if (!(utilization > 0) || !Number.isFinite(costUsd) || costUsd <= 0) {
    return null;
  }
  return (costUsd / utilization) * 100;
}

/** Exponential moving average: fold a new sample into the running estimate. */
export function foldEma(prev: number | null, sample: number): number {
  if (prev == null || !Number.isFinite(prev)) return sample;
  return prev + EMA_ALPHA * (sample - prev);
}

/**
 * Apply the deadband: return `prevDisplay` unless `ema` has drifted past the
 * threshold, in which case snap to `ema`. Pure so it can be unit-tested.
 */
export function applyDeadband(prevDisplay: number | null, ema: number): number {
  if (prevDisplay == null || !(prevDisplay > 0)) return ema;
  if (Math.abs(ema - prevDisplay) > DISPLAY_DEADBAND_RATIO * prevDisplay) {
    return ema;
  }
  return prevDisplay;
}

/** Trend of the estimate vs a baseline. up = provider raised quota, down = provider cut it. */
export function classifyTrend(
  baseline: number | null,
  current: number,
): "up" | "down" | "flat" {
  if (baseline == null || !(baseline > 0)) return "flat";
  const diff = current - baseline;
  if (Math.abs(diff) <= TREND_EPS_RATIO * baseline) return "flat";
  return diff > 0 ? "up" : "down";
}

/** Local spend settled against one step of utilization. */
export interface QuotaSpan {
  /** Local spend since the previous step, dollars. */
  dC: number;
  /** Size of the step, percentage points. */
  dU: number;
}

/** Everything the estimator carries from one observation to the next. */
export interface EstimatorState {
  /** Previous sample's C; null at the start of a segment. */
  prevC: number | null;
  /** Highest U seen in this segment; null at the start of a segment. */
  anchorU: number | null;
  /** Local spend since the last step of U, not yet settled into a span. */
  pendingDC: number;
  /** Settled spans, oldest first. */
  spans: QuotaSpan[];
  /**
   * Non-null while C still carries the previous window's spend after a reset;
   * `refC` is the last trusted C before the reset.
   */
  stale: { refC: number } | null;
  /** Smoothed estimate; null until the first instant estimate. */
  ema: number | null;
  /** Deadbanded value actually shown. */
  display: number | null;
  /** EMA before folding the current sample, used as the trend baseline. */
  baseline: number | null;
}

/**
 * Copy of `prev` with the segment cleared and the estimate and stale marker
 * kept, for samples that cannot be compared with the previous one (a recording
 * gap). Null stays null.
 */
export function startNewSegment(
  prev: EstimatorState | null,
): EstimatorState | null {
  if (prev == null) return null;
  // Rows recorded while the probe still measured C against an expired
  // `resetsAt` carry the old window's spend for days, across gaps; dropping
  // the marker there turns those rows into C/U spikes. New rows cannot enter
  // that state: `tierWindowStartSec` returns null for an expired window, so no
  // spend is recorded.
  return { ...prev, prevC: null, anchorU: null, pendingDC: 0, spans: [] };
}

/** 100 · Σ(w·dC) ÷ Σ(w·dU), each span weighted by the points of newer spans. */
function recencyWeightedQuotaUsd(spans: readonly QuotaSpan[]): number {
  let weightedDC = 0;
  let weightedDU = 0;
  let age = 0;
  for (let i = spans.length - 1; i >= 0; i--) {
    const weight = 0.5 ** (age / RECENCY_HALF_LIFE_PP);
    weightedDC += weight * spans[i].dC;
    weightedDU += weight * spans[i].dU;
    age += spans[i].dU;
  }
  return (100 * weightedDC) / weightedDU;
}

/** Drop the oldest spans while the rest still cover SPAN_KEEP_PP; cap at MAX_SPANS. */
function trimSpans(spans: QuotaSpan[]): QuotaSpan[] {
  let total = spans.reduce((acc, s) => acc + s.dU, 0);
  let first = 0;
  while (
    first < spans.length &&
    (spans.length - first > MAX_SPANS ||
      total - spans[first].dU >= SPAN_KEEP_PP)
  ) {
    total -= spans[first].dU;
    first++;
  }
  return first === 0 ? spans : spans.slice(first);
}

/** The estimate-related fields of the state. */
type EstimateFields = Pick<EstimatorState, "ema" | "display" | "baseline">;

function foldInstant(
  prev: EstimateFields,
  instant: number | null,
): EstimateFields {
  if (instant == null) return prev;
  const ema = foldEma(prev.ema, instant);
  return {
    baseline: prev.ema ?? instant,
    ema,
    display: applyDeadband(prev.display, ema),
  };
}

function instantEstimate(
  spans: readonly QuotaSpan[],
  costUsd: number,
  utilization: number,
  provisionalOK: boolean,
): number | null {
  const cumulative = cumulativeQuotaUsd(costUsd, utilization);
  if (spans.length > 0) {
    const recent = recencyWeightedQuotaUsd(spans);
    return cumulative == null ? recent : Math.max(recent, cumulative);
  }
  return provisionalOK ? cumulative : null;
}

/**
 * Fold one (spend, utilization) observation into the estimator — the single
 * step of the whole algorithm, shared by the live footer and the history
 * replay. Returns a new state; `prev` is not modified.
 *
 * The footer folds every ~5 min and the history chart hourly, so the two show
 * the same algorithm at different sample rates, not the same number at the
 * same moment.
 *
 * `allowProvisional` lets the (low-biased) cumulative inference stand in until
 * the first span settles, provided the state carries no estimate yet. The live
 * hook gates it on having enough local token history; the history replay
 * leaves it off.
 */
export function foldQuotaSample(
  prev: EstimatorState | null,
  costUsd: number,
  utilization: number,
  allowProvisional = false,
): EstimatorState {
  if (prev?.stale != null) {
    // C still counts the previous window until it falls below the last trusted
    // value; only then do (C, U) describe the same window again.
    if (costUsd >= prev.stale.refC) return prev;
    return {
      ...prev,
      prevC: costUsd,
      anchorU: utilization,
      pendingDC: 0,
      spans: [],
      stale: null,
    };
  }

  const estimate: EstimateFields = {
    ema: prev?.ema ?? null,
    display: prev?.display ?? null,
    baseline: prev?.baseline ?? null,
  };
  let anchorU = utilization;
  let pendingDC = prev?.pendingDC ?? 0;
  let spans = prev?.spans ?? [];

  if (prev?.prevC != null && prev.anchorU != null) {
    const dU = utilization - prev.anchorU;
    const dC = costUsd - prev.prevC;
    // C only grows within a window, so U falling together with C can only be
    // a reset, however small the drop; 5h windows often reset below 20%.
    const largeDrop = dU < -RESET_DROP_PCT;
    if (largeDrop || (dU < 0 && dC < 0)) {
      spans = [];
      pendingDC = 0;
      if (largeDrop && dC >= 0) {
        // The window reset but C did not fall with it: its window start is
        // still the old one, so C/U would be wildly inflated.
        return {
          ...estimate,
          prevC: prev.prevC,
          anchorU,
          pendingDC,
          spans,
          stale: { refC: prev.prevC },
        };
      }
    } else if (dU <= 0) {
      // U has not stepped; small drops with C still rising are jitter and must
      // not lower the anchor, or 52 → 51 → 52 would count as a step.
      pendingDC += Math.max(dC, 0);
      anchorU = prev.anchorU;
    } else {
      const settled = pendingDC + Math.max(dC, 0);
      pendingDC = 0;
      // A step with no local spend is other machines' usage: move the anchor
      // past it without a span.
      if (settled > 0) spans = [...spans, { dC: settled, dU }];
    }
  }

  const instant = instantEstimate(
    spans,
    costUsd,
    utilization,
    allowProvisional && estimate.ema == null,
  );

  return {
    ...foldInstant(estimate, instant),
    prevC: costUsd,
    anchorU,
    pendingDC,
    spans: trimSpans(spans),
    stale: null,
  };
}
