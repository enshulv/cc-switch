import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureFreshSessionUsage } from "./freshSessionUsage";
import { settingsApi } from "@/lib/api/settings";
import { usageApi } from "@/lib/api/usage";
import type { Settings } from "@/types";
import type { SessionSyncResult } from "@/types/usage";

vi.mock("@/lib/api/settings", () => ({ settingsApi: { get: vi.fn() } }));
vi.mock("@/lib/api/usage", () => ({
  usageApi: { syncSessionUsage: vi.fn() },
}));

const getSettings = vi.mocked(settingsApi.get);
const syncSessionUsage = vi.mocked(usageApi.syncSessionUsage);

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("ensureFreshSessionUsage", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    getSettings.mockResolvedValue(settings({ sessionAutoSyncEnabled: true }));
    syncSessionUsage.mockResolvedValue(SYNC_RESULT);
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("scans the session logs when auto sync is on", async () => {
    await ensureFreshSessionUsage();
    expect(syncSessionUsage).toHaveBeenCalledTimes(1);
  });

  it("scans the session logs when the auto sync setting is absent", async () => {
    getSettings.mockResolvedValue(settings());
    await ensureFreshSessionUsage();
    expect(syncSessionUsage).toHaveBeenCalledTimes(1);
  });

  it("does not scan when auto sync is off", async () => {
    getSettings.mockResolvedValue(settings({ sessionAutoSyncEnabled: false }));
    await expect(ensureFreshSessionUsage()).resolves.toBeUndefined();
    expect(syncSessionUsage).not.toHaveBeenCalled();
  });

  it("shares one scan between calls that overlap it", async () => {
    const scan = deferred<SessionSyncResult>();
    syncSessionUsage.mockReturnValueOnce(scan.promise);

    const first = ensureFreshSessionUsage();
    const second = ensureFreshSessionUsage();
    await vi.waitFor(() => expect(syncSessionUsage).toHaveBeenCalledTimes(1));
    const third = ensureFreshSessionUsage();

    let settled = false;
    void Promise.all([first, second, third]).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    scan.resolve(SYNC_RESULT);
    await Promise.all([first, second, third]);
    expect(syncSessionUsage).toHaveBeenCalledTimes(1);
  });

  it("starts a new scan once the previous one has finished", async () => {
    await ensureFreshSessionUsage();
    await ensureFreshSessionUsage();
    expect(syncSessionUsage).toHaveBeenCalledTimes(2);
  });

  it("resolves and warns when the scan fails, and scans again on the next call", async () => {
    syncSessionUsage.mockRejectedValueOnce(new Error("db locked"));
    await expect(ensureFreshSessionUsage()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);

    await ensureFreshSessionUsage();
    expect(syncSessionUsage).toHaveBeenCalledTimes(2);
  });

  it("warns when the scan reports errors", async () => {
    syncSessionUsage.mockResolvedValueOnce({
      ...SYNC_RESULT,
      errors: ["~/.codex/sessions/a.jsonl: permission denied"],
    });
    await ensureFreshSessionUsage();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not warn after a clean scan", async () => {
    await ensureFreshSessionUsage();
    expect(warn).not.toHaveBeenCalled();
  });

  it("resolves and warns without scanning when the settings cannot be read", async () => {
    getSettings.mockRejectedValueOnce(new Error("ipc down"));
    await expect(ensureFreshSessionUsage()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(syncSessionUsage).not.toHaveBeenCalled();

    await ensureFreshSessionUsage();
    expect(syncSessionUsage).toHaveBeenCalledTimes(1);
  });
});

describe("ensureFreshSessionUsage with a scan that does not finish", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    getSettings.mockResolvedValue(settings());
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    warn.mockRestore();
  });

  /** 记录 promise 是否已结算 */
  function track(promise: Promise<void>) {
    const state = { settled: false };
    void promise.then(() => {
      state.settled = true;
    });
    return state;
  }

  it("resolves 30 seconds after the call and keeps sharing the hung scan", async () => {
    const hung = deferred<SessionSyncResult>();
    syncSessionUsage.mockReturnValueOnce(hung.promise);

    const first = track(ensureFreshSessionUsage());
    await vi.advanceTimersByTimeAsync(29_999);
    expect(first.settled).toBe(false);
    expect(syncSessionUsage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(first.settled).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);

    // 扫描还挂着：新调用共用它，不另起扫描，自己的 30 秒从调用时起算
    const second = track(ensureFreshSessionUsage());
    await vi.advanceTimersByTimeAsync(29_999);
    expect(second.settled).toBe(false);
    expect(syncSessionUsage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(second.settled).toBe(true);

    // 挂住的扫描结束后，下一次调用发起新扫描
    hung.resolve(SYNC_RESULT);
    await vi.advanceTimersByTimeAsync(0);
    syncSessionUsage.mockResolvedValueOnce(SYNC_RESULT);
    const third = track(ensureFreshSessionUsage());
    await vi.advanceTimersByTimeAsync(0);
    expect(syncSessionUsage).toHaveBeenCalledTimes(2);
    expect(third.settled).toBe(true);
  });

  it("resolves as soon as a quick scan finishes, without waiting out the limit", async () => {
    syncSessionUsage.mockResolvedValueOnce(SYNC_RESULT);
    const call = track(ensureFreshSessionUsage());
    await vi.advanceTimersByTimeAsync(0);
    expect(call.settled).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
