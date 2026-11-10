/**
 * Bring local spend up to date before it is measured for the quota estimate.
 *
 * Local spend (C) comes from the session logs, which the backend imports on a
 * timer, while the provider's utilization (U) is live. Measuring C right after
 * a step of U would miss the spend that caused the step, so the quota estimate
 * scans the logs first.
 */
import { settingsApi } from "@/lib/api/settings";
import { usageApi } from "@/lib/api/usage";

/**
 * Longest a caller waits for the scan. The backend serializes scans behind one
 * lock, so a stuck scan (an unresponsive network drive, say) would otherwise
 * stall every measurement indefinitely.
 */
const SCAN_WAIT_LIMIT_MS = 30_000;

let inFlight: Promise<void> | null = null;

/**
 * Scan the session logs into the usage database, unless the user turned
 * session auto sync off (`sessionAutoSyncEnabled === false`; absent means on).
 *
 * Calls made while a scan is in flight share it; the next call after it
 * settles starts a new one. Always resolves, at the latest 30 seconds after
 * the call, even when the scan is still running or has failed; the caller then
 * measures whatever the database holds.
 */
export function ensureFreshSessionUsage(): Promise<void> {
  // Cleared only when the scan itself ends, so a scan that outlives the wait
  // limit is still shared instead of being started again behind it.
  inFlight ??= syncUnlessAutoSyncOff().finally(() => {
    inFlight = null;
  });
  return waitAtMost(inFlight, SCAN_WAIT_LIMIT_MS);
}

function waitAtMost(scan: Promise<void>, limitMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.warn(
        `[freshSessionUsage] session log scan still running after ${limitMs} ms; measuring without it`,
      );
      resolve();
    }, limitMs);
    void scan.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function syncUnlessAutoSyncOff(): Promise<void> {
  let autoSyncEnabled: boolean;
  try {
    const settings = await settingsApi.get();
    autoSyncEnabled = settings.sessionAutoSyncEnabled !== false;
  } catch (error) {
    console.warn("[freshSessionUsage] failed to read settings", error);
    return;
  }
  if (!autoSyncEnabled) return;

  try {
    const result = await usageApi.syncSessionUsage();
    if (result.errors.length > 0) {
      console.warn(
        "[freshSessionUsage] session log scan reported errors",
        result.errors,
      );
    }
  } catch (error) {
    console.warn("[freshSessionUsage] failed to scan session logs", error);
  }
}
