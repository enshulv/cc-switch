import type { PropsWithChildren } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useQuotaHistoryProbe } from "@/hooks/useQuotaHistoryProbe";
import { subscriptionApi } from "@/lib/api/subscription";
import { quotaHistoryApi } from "@/lib/api/quotaHistory";
import { usageApi } from "@/lib/api/usage";
import { settingsApi } from "@/lib/api/settings";
import type { Settings, VisibleApps } from "@/types";
import type { ModelStats, SessionSyncResult } from "@/types/usage";
import type { SubscriptionQuota } from "@/types/subscription";

vi.mock("@/lib/api/subscription", () => ({
  subscriptionApi: { getQuota: vi.fn() },
}));
vi.mock("@/lib/api/quotaHistory", () => ({
  quotaHistoryApi: { query: vi.fn(), record: vi.fn() },
}));
vi.mock("@/lib/api/usage", () => ({
  usageApi: { getModelStats: vi.fn(), syncSessionUsage: vi.fn() },
}));
vi.mock("@/lib/api/settings", () => ({ settingsApi: { get: vi.fn() } }));

const getQuota = vi.mocked(subscriptionApi.getQuota);
const recordHistory = vi.mocked(quotaHistoryApi.record);
const getModelStats = vi.mocked(usageApi.getModelStats);
const syncSessionUsage = vi.mocked(usageApi.syncSessionUsage);
const getSettings = vi.mocked(settingsApi.get);

const HOUR_MS = 3_600_000;

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

/** 两个窗口都在有效期内的成功读数 */
function quotaReading(tool: string): SubscriptionQuota {
  const now = Date.now();
  return {
    tool,
    credentialStatus: "valid",
    credentialMessage: null,
    success: true,
    tiers: [
      {
        name: "five_hour",
        utilization: 10,
        resetsAt: new Date(now + 2 * HOUR_MS).toISOString(),
      },
      {
        name: "seven_day",
        utilization: 20,
        resetsAt: new Date(now + 72 * HOUR_MS).toISOString(),
      },
    ],
    extraUsage: null,
    error: null,
    queriedAt: now,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const ONLY_CLAUDE: Partial<VisibleApps> = {
  claude: true,
  codex: false,
  gemini: false,
};
const ONLY_GEMINI: Partial<VisibleApps> = {
  claude: false,
  codex: false,
  gemini: true,
};

let client: QueryClient;

function renderProbe(visibleApps: Partial<VisibleApps>) {
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useQuotaHistoryProbe({ visibleApps }), { wrapper });
}

/** 让已排队的 promise 与 effect 都跑完 */
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

describe("useQuotaHistoryProbe: scanning the session logs before measuring", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    getQuota.mockImplementation(async (tool) => quotaReading(tool));
    recordHistory.mockResolvedValue(true);
    getModelStats.mockResolvedValue(modelStats(50));
    syncSessionUsage.mockResolvedValue(SYNC_RESULT);
    getSettings.mockResolvedValue(settings());
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    client.clear();
    vi.clearAllMocks();
    warn.mockRestore();
  });

  it("scans once before measuring the windows of an estimable app", async () => {
    const scan = deferred<SessionSyncResult>();
    syncSessionUsage.mockReturnValueOnce(scan.promise);
    renderProbe(ONLY_CLAUDE);

    await waitFor(() => expect(syncSessionUsage).toHaveBeenCalledTimes(1));
    await settle();
    expect(getModelStats).not.toHaveBeenCalled();
    expect(recordHistory).not.toHaveBeenCalled();

    await act(async () => {
      scan.resolve(SYNC_RESULT);
    });
    await waitFor(() => expect(recordHistory).toHaveBeenCalledTimes(1));
    // 两个窗口各量一次，扫描只在循环前做一次
    expect(getModelStats).toHaveBeenCalledTimes(2);
    expect(syncSessionUsage).toHaveBeenCalledTimes(1);
    expect(syncSessionUsage.mock.invocationCallOrder[0]).toBeLessThan(
      getModelStats.mock.invocationCallOrder[0],
    );
    const [, , tiers] = recordHistory.mock.calls[0];
    expect(tiers.map((t) => t.spendUsd)).toEqual([50, 50]);
  });

  it("does not scan for an app it cannot estimate", async () => {
    renderProbe(ONLY_GEMINI);
    await waitFor(() => expect(recordHistory).toHaveBeenCalledTimes(1));
    expect(recordHistory.mock.calls[0][0]).toBe("gemini");
    expect(syncSessionUsage).not.toHaveBeenCalled();
    expect(getSettings).not.toHaveBeenCalled();
    expect(getModelStats).not.toHaveBeenCalled();
  });

  it("still measures when the scan fails", async () => {
    syncSessionUsage.mockRejectedValue(new Error("db locked"));
    renderProbe(ONLY_CLAUDE);
    await waitFor(() => expect(recordHistory).toHaveBeenCalledTimes(1));
    expect(syncSessionUsage).toHaveBeenCalledTimes(1);
    const [, , tiers] = recordHistory.mock.calls[0];
    expect(tiers.map((t) => t.spendUsd)).toEqual([50, 50]);
  });

  it("measures without scanning when auto sync is off", async () => {
    getSettings.mockResolvedValue(settings({ sessionAutoSyncEnabled: false }));
    renderProbe(ONLY_CLAUDE);
    await waitFor(() => expect(recordHistory).toHaveBeenCalledTimes(1));
    expect(getSettings).toHaveBeenCalled();
    expect(syncSessionUsage).not.toHaveBeenCalled();
    expect(getModelStats).toHaveBeenCalledTimes(2);
  });
});
