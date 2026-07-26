import type { Database } from "../db/types.js";
import { newId } from "../lib/security.js";
import type { NotificationProvider } from "./provider.js";
import {
  enqueueDueNotificationDigests,
  processNotificationBatch,
  writeWorkerHeartbeat,
} from "./service.js";

export interface NotificationWorkerOptions {
  database: Database;
  provider: NotificationProvider;
  workerName: string;
  releaseId: string;
  pollIntervalMs: number;
  batchSize: number;
  leaseSeconds: number;
  maxAttempts: number;
  signal: AbortSignal;
  now?: () => Date;
  onError?: (error: unknown) => void;
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export async function runNotificationWorker(options: NotificationWorkerOptions): Promise<void> {
  const clock = options.now ?? (() => new Date());
  const instanceId = newId();
  const startedAt = clock();

  while (!options.signal.aborted) {
    const cycleAt = clock();
    let scheduled = false;
    let submitted = false;
    let failed = false;
    try {
      scheduled = (await enqueueDueNotificationDigests(options.database, cycleAt)) > 0;
      const outcomes = await processNotificationBatch(options.database, options.provider, {
        batchSize: options.batchSize,
        leaseSeconds: options.leaseSeconds,
        maxAttempts: options.maxAttempts,
        now: clock,
      });
      submitted = outcomes.includes("submitted");
      failed = outcomes.some((outcome) => outcome === "failed" || outcome === "ambiguous");
    } catch (error) {
      failed = true;
      options.onError?.(error);
    }

    try {
      await writeWorkerHeartbeat(options.database, {
        workerName: options.workerName,
        instanceId,
        releaseId: options.releaseId,
        provider: options.provider.name,
        startedAt,
        seenAt: clock(),
        scheduled,
        delivered: submitted,
        failed,
      });
    } catch (error) {
      options.onError?.(error);
    }
    await wait(options.pollIntervalMs, options.signal);
  }
}
