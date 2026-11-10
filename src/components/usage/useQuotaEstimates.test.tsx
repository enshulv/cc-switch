import type { PropsWithChildren } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useQuotaEstimates } from "./useQuotaEstimates";
import { usageApi } from "@/lib/api/usage";
import { settingsApi } from "@/lib/api/settings";
import { quotaHistoryApi, type QuotaHistoryRow } from "@/lib/api/quotaHistory";
import { quotaHistoryKeys } from "@/lib/query/quotaHistory";
import type { Settings } from "@/types";
import type {
  ModelStats,
  SessionSyncResult,
  UsageSummary,
} from "@/types/usage";
import type { QuotaTier, SubscriptionQuota } from "@/types/subscription";

vi.mock("@/lib/api/usage", () => ({
  usageApi: {
    getModelStats: vi.fn(),
    getUsageSummary: vi.fn(),
    syncSessionUsage: vi.fn(),
  },
}));
vi.mock("@/lib/api/settings", () => ({ settingsApi: { get: vi.fn() } }));
vi.mock("@/lib/api/quotaHistory", () => ({
  quotaHistoryApi: { query: vi.fn(), record: vi.fn() },
}));

const getModelStats = vi.mocked(usageApi.getModelStats);
const getUsageSummary = vi.mocked(usageApi.getUsageSummary);
const syncSessionUsage = vi.mocked(usageApi.syncSessionUsage);
const getSettings = vi.mocked(settingsApi.get);
const queryHistory = vi.mocked(quotaHistoryApi.query);

const SYNC_RESULT: SessionSyncResult = {
  imported: 0,
  skipped: 0,
  filesScanned: 0,
  suspectedDuplicates: 0,
  deferredFiles: 0,
  errors: [],
};

function settings(overrides: Partial<Settings> = {}): Settings {
  return { showInTray: false, minimizeToTrayOnClose: false, ...overrides };
}

const HOUR_MS = 3_600_000;
const QUERIED_AT = 1_000;
const ENOUGH_TOKENS_FOR_PROVISIONAL = 1_000_000_000;

function modelStats(totalCost: number): ModelStats[] {
  return [
    {
      model: "claude-sonnet-5",
      requestCount: 1,
      totalTokens: 1,
      totalCost: String(totalCost),
      avgCostPerRequest: "0",
      successRate: 1,
    },
  ];
}

function usageSummary(realTotalTokens: number): UsageSummary {
  return {
    totalRequests: 1,
    totalCost: "0",
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    successRate: 1,
    realTotalTokens,
    cacheHitRate: 0,
  };
}

function tier(
  name: string,
  utilization: number,
  resetsInMs: number,
): QuotaTier {
  return {
    name,
    utilization,
    resetsAt: new Date(Date.now() + resetsInMs).toISOString(),
  };
}

function quota(tiers: QuotaTier[], queriedAt = QUERIED_AT): SubscriptionQuota {
  return {
    tool: "claude",
    credentialStatus: "valid",
    credentialMessage: null,
    success: true,
    tiers,
    extraUsage: null,
    error: null,
    queriedAt,
  };
}

function historyRow(
  hoursAgo: number,
  tierName: string,
  utilization: number,
  spendUsd: number,
): QuotaHistoryRow {
  return {
    appId: "claude",
    hour: Math.floor(Date.now() / HOUR_MS) - hoursAgo,
    tier: tierName,
    utilization,
    usedUsd: null,
    maxUsd: null,
    spendUsd,
  };
}

/** 回放后 five_hour 最后一点是 $1000（第一格丢弃，之后 10pp 花 $100） */
const historySeeding1000 = [
  historyRow(4, "five_hour", 10, 100),
  historyRow(3, "five_hour", 11, 110),
  historyRow(2, "five_hour", 21, 210),
];

/** 回放后 five_hour 最后一点是 $2000（第一格丢弃，之后 1pp 花 $20） */
const historySeeding2000 = [
  historyRow(4, "five_hour", 10, 100),
  historyRow(3, "five_hour", 11, 120),
  historyRow(2, "five_hour", 12, 140),
];

/** 回放后 five_hour 是 $1000，seven_day 是 $3000（第一格丢弃，之后 1pp 花 $30） */
const historySeedingBothWindows = [
  ...historySeeding1000,
  historyRow(4, "seven_day", 10, 100),
  historyRow(3, "seven_day", 11, 130),
  historyRow(2, "seven_day", 12, 160),
];

/** 之后两份快照与首份各相隔 5 分钟、10 分钟 */
const NEXT_QUERIED_AT = QUERIED_AT + 300_000;
const THIRD_QUERIED_AT = QUERIED_AT + 600_000;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * 5h 与 7d 两个窗口都在有效期内。provisional 的门槛挂在 7d 窗口上，
 * 少了 7d 窗口就永远不走 provisional。
 */
function liveQuota(
  utilization = 10,
  queriedAt = QUERIED_AT,
): SubscriptionQuota {
  return quota(
    [
      tier("five_hour", utilization, 2 * HOUR_MS),
      tier("seven_day", utilization, 72 * HOUR_MS),
    ],
    queriedAt,
  );
}

let client: QueryClient;

function renderEstimates(appId: string, q: SubscriptionQuota) {
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(
    ({ current }: { current: SubscriptionQuota }) =>
      useQuotaEstimates(appId, current),
    { wrapper, initialProps: { current: q } },
  );
}

/** 让已排队的 promise 与 effect 都跑完 */
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

describe("useQuotaEstimates", () => {
  beforeEach(() => {
    client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // 实时样本：C=$50、U=10，累积推断是 $500
    getModelStats.mockResolvedValue(modelStats(50));
    getUsageSummary.mockResolvedValue(
      usageSummary(ENOUGH_TOKENS_FOR_PROVISIONAL),
    );
    getSettings.mockResolvedValue(settings());
    syncSessionUsage.mockResolvedValue(SYNC_RESULT);
  });

  afterEach(() => {
    client.clear();
    vi.clearAllMocks();
  });

  it("starts from the history's latest estimate", async () => {
    queryHistory.mockResolvedValue(historySeeding1000);
    const { result } = renderEstimates("claude", liveQuota());
    await waitFor(() =>
      expect(result.current.get("five_hour")?.quotaUsd).toBeCloseTo(1000, 6),
    );
  });

  it("queries the last 14 days of history for every app", async () => {
    queryHistory.mockResolvedValue([]);
    const hourBefore = Math.floor(Date.now() / HOUR_MS);
    renderEstimates("claude", liveQuota());
    await waitFor(() => expect(queryHistory).toHaveBeenCalled());
    const hourAfter = Math.floor(Date.now() / HOUR_MS);
    const [appId, startHour, endHour] = queryHistory.mock.calls[0];
    expect(appId).toBeNull();
    expect(endHour - startHour).toBe(14 * 24);
    // 跨整点时 render 期间的小时序号可能落在前后任一边
    expect(endHour).toBeGreaterThanOrEqual(hourBefore);
    expect(endHour).toBeLessThanOrEqual(hourAfter);
  });

  it("falls back to the provisional estimate when history is empty", async () => {
    queryHistory.mockResolvedValue([]);
    const { result } = renderEstimates("claude", liveQuota());
    await waitFor(() =>
      expect(result.current.get("five_hour")?.quotaUsd).toBeCloseTo(500, 6),
    );
  });

  it("falls back to the provisional estimate when the history query fails", async () => {
    queryHistory.mockRejectedValue(new Error("db locked"));
    const { result } = renderEstimates("claude", liveQuota());
    await waitFor(() =>
      expect(result.current.get("five_hour")?.quotaUsd).toBeCloseTo(500, 6),
    );
  });

  it("waits for the history before folding the first live sample", async () => {
    const history = deferred<QuotaHistoryRow[]>();
    queryHistory.mockReturnValue(history.promise);
    const { result } = renderEstimates("claude", liveQuota());

    await waitFor(() => expect(getModelStats).toHaveBeenCalled());
    await waitFor(() => expect(getUsageSummary).toHaveBeenCalled());
    await settle();
    // 实时样本已落地；若此时就折，会显示 provisional 的 $500，种子之后再也用不上
    expect(result.current.get("five_hour")?.quotaUsd).toBeNull();

    await act(async () => {
      history.resolve(historySeeding1000);
    });
    await waitFor(() =>
      expect(result.current.get("five_hour")?.quotaUsd).toBeCloseTo(1000, 6),
    );
  });

  it("uses the seed only when the record is created", async () => {
    queryHistory.mockResolvedValue(historySeeding1000);
    const { result, rerender } = renderEstimates("claude", liveQuota());
    await waitFor(() =>
      expect(result.current.get("five_hour")?.quotaUsd).toBeCloseTo(1000, 6),
    );

    // 换一份种子是 $2000 的历史并让它重查
    queryHistory.mockResolvedValue(historySeeding2000);
    await act(async () => {
      await client.invalidateQueries({ queryKey: quotaHistoryKeys.all });
    });
    await waitFor(() => expect(queryHistory).toHaveBeenCalledTimes(2));

    // 之后两份快照：U 10→11 是本段第一格，丢弃；U 11→16、C $70→$170 结算 {100, 5}，
    // 段比值 $2000，EMA 从 $1000 走一半到 $1500。
    // 重新播种的话，每个样本都只开段，停在种子 $1000 或 $2000。
    getModelStats.mockResolvedValue(modelStats(70));
    rerender({ current: liveQuota(11, NEXT_QUERIED_AT) });
    await settle();
    expect(result.current.get("five_hour")?.quotaUsd).toBeCloseTo(1000, 6);

    getModelStats.mockResolvedValue(modelStats(170));
    rerender({ current: liveQuota(16, THIRD_QUERIED_AT) });
    await waitFor(() =>
      expect(result.current.get("five_hour")?.quotaUsd).toBeCloseTo(1500, 6),
    );
  });

  it("seeds each window from its own history", async () => {
    queryHistory.mockResolvedValue(historySeedingBothWindows);
    const { result } = renderEstimates("claude", liveQuota());
    await waitFor(() => {
      expect(result.current.get("five_hour")?.quotaUsd).toBeCloseTo(1000, 6);
      expect(result.current.get("seven_day")?.quotaUsd).toBeCloseTo(3000, 6);
    });
  });

  it("shows the seed before the first measurable sample, then folds that sample", async () => {
    queryHistory.mockResolvedValue(historySeeding1000);
    getModelStats.mockResolvedValue(modelStats(0));
    const { result, rerender } = renderEstimates("claude", liveQuota());
    await waitFor(() =>
      expect(result.current.get("five_hour")?.quotaUsd).toBeCloseTo(1000, 6),
    );

    // 同一份快照重查到 C=$50：要折进去，成为下一格的起点
    getModelStats.mockResolvedValue(modelStats(50));
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["quotaEstimate"] });
    });
    await settle();

    // 之后两份快照：从 $50、10% 起算，U 10→11 是本段第一格，丢弃；
    // U 11→16、C $70→$170 结算 {100, 5}，EMA 到 $1500。
    // 若上一步被种子记录挡掉，U=11 才开段，U 11→16 成了第一格被丢弃，停在 $1000。
    getModelStats.mockResolvedValue(modelStats(70));
    rerender({ current: liveQuota(11, NEXT_QUERIED_AT) });
    await settle();
    expect(result.current.get("five_hour")?.quotaUsd).toBeCloseTo(1000, 6);

    getModelStats.mockResolvedValue(modelStats(170));
    rerender({ current: liveQuota(16, THIRD_QUERIED_AT) });
    await waitFor(() =>
      expect(result.current.get("five_hour")?.quotaUsd).toBeCloseTo(1500, 6),
    );
  });

  it("skips windows whose reset time has already passed", async () => {
    queryHistory.mockResolvedValue([]);
    const { result } = renderEstimates(
      "claude",
      quota([
        tier("five_hour", 10, -HOUR_MS),
        tier("seven_day", 10, 2 * HOUR_MS),
      ]),
    );
    await waitFor(() =>
      expect(result.current.get("seven_day")?.quotaUsd).toBeCloseTo(500, 6),
    );
    expect(result.current.has("five_hour")).toBe(false);
    expect(getModelStats).toHaveBeenCalledTimes(1);
  });

  it("does not query history for apps it cannot estimate", async () => {
    queryHistory.mockResolvedValue(historySeeding1000);
    const { result } = renderEstimates("gemini", liveQuota());
    await settle();
    expect(queryHistory).not.toHaveBeenCalled();
    expect(result.current.size).toBe(0);
  });
});

describe("useQuotaEstimates: scanning the session logs before measuring", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    getModelStats.mockResolvedValue(modelStats(50));
    getUsageSummary.mockResolvedValue(
      usageSummary(ENOUGH_TOKENS_FOR_PROVISIONAL),
    );
    getSettings.mockResolvedValue(settings());
    syncSessionUsage.mockResolvedValue(SYNC_RESULT);
    queryHistory.mockResolvedValue([]);
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    client.clear();
    vi.clearAllMocks();
    warn.mockRestore();
  });

  it("measures no window until the scan finishes, and scans once for all windows", async () => {
    const scan = deferred<SessionSyncResult>();
    syncSessionUsage.mockReturnValueOnce(scan.promise);
    const { result } = renderEstimates("claude", liveQuota());

    await waitFor(() => expect(syncSessionUsage).toHaveBeenCalledTimes(1));
    await settle();
    expect(getModelStats).not.toHaveBeenCalled();

    await act(async () => {
      scan.resolve(SYNC_RESULT);
    });
    await waitFor(() => expect(getModelStats).toHaveBeenCalledTimes(2));
    expect(syncSessionUsage).toHaveBeenCalledTimes(1);
    expect(syncSessionUsage.mock.invocationCallOrder[0]).toBeLessThan(
      getModelStats.mock.invocationCallOrder[0],
    );
    await waitFor(() =>
      expect(result.current.get("five_hour")?.quotaUsd).toBeCloseTo(500, 6),
    );
  });

  it("still measures when the scan fails", async () => {
    syncSessionUsage.mockRejectedValue(new Error("db locked"));
    const { result } = renderEstimates("claude", liveQuota());
    await waitFor(() =>
      expect(result.current.get("five_hour")?.quotaUsd).toBeCloseTo(500, 6),
    );
    expect(syncSessionUsage).toHaveBeenCalled();
  });

  it("still measures when the settings cannot be read", async () => {
    getSettings.mockRejectedValue(new Error("ipc down"));
    const { result } = renderEstimates("claude", liveQuota());
    await waitFor(() =>
      expect(result.current.get("five_hour")?.quotaUsd).toBeCloseTo(500, 6),
    );
    expect(getSettings).toHaveBeenCalled();
  });

  it("measures without scanning when auto sync is off", async () => {
    getSettings.mockResolvedValue(settings({ sessionAutoSyncEnabled: false }));
    const { result } = renderEstimates("claude", liveQuota());
    await waitFor(() =>
      expect(result.current.get("five_hour")?.quotaUsd).toBeCloseTo(500, 6),
    );
    expect(getSettings).toHaveBeenCalled();
    expect(syncSessionUsage).not.toHaveBeenCalled();
  });
});
