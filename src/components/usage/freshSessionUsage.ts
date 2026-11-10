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

let inFlight: Promise<void> | null = null;

/**
 * Scan the session logs into the usage database, unless the user turned
 * session auto sync off (`sessionAutoSyncEnabled === false`; absent means on).
 *
 * Calls made while a scan is in flight share it; the next call after it
 * settles starts a new one. Always resolves: a failure to read the settings or
 * to scan is logged with `console.warn`, and the caller measures whatever the
 * database already holds.
 */
export function ensureFreshSessionUsage(): Promise<void> {
  inFlight ??= syncUnlessAutoSyncOff().finally(() => {
    inFlight = null;
  });
  return inFlight;
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
    await usageApi.syncSessionUsage();
  } catch (error) {
    console.warn("[freshSessionUsage] failed to scan session logs", error);
  }
}
