import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { asString, asNumber, asBoolean, parseObject } from "@paperclipai/adapter-utils/server-utils";
import {
  parseClaudeStreamJson,
  describeClaudeFailure,
  isClaudeMaxTurnsResult,
  isClaudeUnknownSessionError,
} from "./parse.js";
import { getSelfPodInfo, getBatchApi, getCoreApi, getLogApi } from "./k8s-client.js";
import { buildJobManifest } from "./job-manifest.js";
import type * as k8s from "@kubernetes/client-node";
import { Writable } from "node:stream";

const POLL_INTERVAL_MS = 2000;
const KEEPALIVE_INTERVAL_MS = 15_000;
const LOG_STREAM_RECONNECT_DELAY_MS = 3_000;
const MAX_LOG_RECONNECT_ATTEMPTS = 50;

/**
 * Wait for the Job's pod to reach a terminal or running state.
 * Returns the pod name once logs can be streamed, or throws on failure.
 */
async function waitForPod(
  namespace: string,
  jobName: string,
  timeoutMs: number,
  onLog: AdapterExecutionContext["onLog"],
  kubeconfigPath?: string,
): Promise<string> {
  const coreApi = getCoreApi(kubeconfigPath);
  const deadline = Date.now() + timeoutMs;
  const labelSelector = `job-name=${jobName}`;

  await onLog("stdout", `[paperclip] Waiting for pod to be scheduled (job: ${jobName})...\n`);

  let lastStatus = "";
  while (Date.now() < deadline) {
    const podList = await coreApi.listNamespacedPod({
      namespace,
      labelSelector,
    });
    const pod = podList.items[0];

    if (!pod) {
      if (lastStatus !== "no-pod") {
        await onLog("stdout", `[paperclip] Waiting for Job controller to create pod...\n`);
        lastStatus = "no-pod";
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      continue;
    }

    const podName = pod.metadata?.name ?? "unknown";
    const phase = pod.status?.phase ?? "Unknown";
    const initStatuses = pod.status?.initContainerStatuses ?? [];
    const containerStatuses = pod.status?.containerStatuses ?? [];

    // Log phase transitions
    const statusKey = `${phase}:${initStatuses.map((s) => s.state?.waiting?.reason ?? s.state?.terminated?.reason ?? "ok").join(",")}:${containerStatuses.map((s) => s.state?.waiting?.reason ?? s.state?.running ? "running" : "waiting").join(",")}`;
    if (statusKey !== lastStatus) {
      const details: string[] = [`phase=${phase}`];
      for (const init of initStatuses) {
        if (init.state?.waiting) details.push(`init/${init.name}: waiting (${init.state.waiting.reason ?? "unknown"})`);
        else if (init.state?.running) details.push(`init/${init.name}: running`);
        else if (init.state?.terminated) details.push(`init/${init.name}: done (exit ${init.state.terminated.exitCode})`);
      }
      for (const cs of containerStatuses) {
        if (cs.state?.waiting) details.push(`${cs.name}: waiting (${cs.state.waiting.reason ?? "unknown"})`);
        else if (cs.state?.running) details.push(`${cs.name}: running`);
      }
      await onLog("stdout", `[paperclip] Pod ${podName}: ${details.join(", ")}\n`);
      lastStatus = statusKey;
    }

    // Ready to stream logs
    if (phase === "Running" || phase === "Succeeded" || phase === "Failed") {
      return podName;
    }

    // Init containers done + main running (phase may still say Pending briefly)
    const allInitsDone = initStatuses.length > 0 && initStatuses.every(
      (s) => s.state?.terminated?.exitCode === 0,
    );
    const mainRunning = containerStatuses.some((s) => s.state?.running);
    if (allInitsDone && mainRunning) {
      return podName;
    }

    // Check for init container failures
    for (const init of initStatuses) {
      const terminated = init.state?.terminated;
      if (terminated && (terminated.exitCode ?? 0) !== 0) {
        throw new Error(`Init container "${init.name}" failed with exit code ${terminated.exitCode}: ${terminated.reason ?? terminated.message ?? "unknown"}`);
      }
      const waiting = init.state?.waiting;
      if (waiting?.reason === "ErrImagePull" || waiting?.reason === "ImagePullBackOff") {
        throw new Error(`Init container "${init.name}" image pull failed: ${waiting.message ?? waiting.reason}`);
      }
      if (waiting?.reason === "CrashLoopBackOff") {
        throw new Error(`Init container "${init.name}" crash loop: ${waiting.message ?? waiting.reason}`);
      }
    }

    // Check for unrecoverable scheduling failures
    const conditions = pod.status?.conditions ?? [];
    const unschedulable = conditions.find(
      (c) => c.type === "PodScheduled" && c.status === "False" && c.reason === "Unschedulable",
    );
    if (unschedulable) {
      throw new Error(`Pod unschedulable: ${unschedulable.message ?? "insufficient resources"}`);
    }

    // Check for main container image pull errors
    for (const cs of containerStatuses) {
      const waiting = cs.state?.waiting;
      if (waiting?.reason === "ErrImagePull" || waiting?.reason === "ImagePullBackOff") {
        throw new Error(`Image pull failed for "${cs.name}": ${waiting.message ?? waiting.reason}`);
      }
      if (waiting?.reason === "CrashLoopBackOff") {
        throw new Error(`Container "${cs.name}" crash loop: ${waiting.message ?? waiting.reason}`);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(`Timed out waiting for pod to be scheduled (${Math.round(timeoutMs / 1000)}s)`);
}

/**
 * Stream pod logs once via follow. Returns accumulated stdout when the
 * stream ends (container exit, API disconnect, or abort signal).
 */
async function streamPodLogsOnce(
  namespace: string,
  podName: string,
  onLog: AdapterExecutionContext["onLog"],
  kubeconfigPath?: string,
  sinceSeconds?: number,
): Promise<string> {
  const logApi = getLogApi(kubeconfigPath);
  const chunks: string[] = [];

  const writable = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const text = chunk.toString("utf-8");
      chunks.push(text);
      void onLog("stdout", text).then(() => callback(), callback);
    },
  });

  try {
    await logApi.log(namespace, podName, "claude", writable, {
      follow: true,
      pretty: false,
      ...(sinceSeconds ? { sinceSeconds } : {}),
    });
  } catch {
    // follow may fail if the container already exited or the API
    // connection dropped — not fatal, caller decides whether to retry.
  }

  return chunks.join("");
}

/**
 * Given content already sent to the UI and new content from a reconnect
 * stream, return only the portion that is genuinely new.
 *
 * The K8s sinceSeconds parameter causes reconnect streams to begin with
 * content that was already sent during a prior stream attempt.  We find
 * the longest prefix of reconnectContent that overlaps with the tail of
 * existingContent (i.e. the largest block of already-seen bytes at the
 * start of the reconnect data) and skip it.
 *
 * Uses the KMP failure-function algorithm for O(|reconnectContent|) time.
 */
function findNewLogContent(existingContent: string, reconnectContent: string): string {
  if (!reconnectContent) return "";
  if (!existingContent) return reconnectContent;

  // The overlap can be at most reconnectContent.length bytes long, so we
  // only need to inspect the matching-length tail of existingContent.
  const limit = Math.min(reconnectContent.length, existingContent.length);
  const pattern = reconnectContent.slice(0, limit);   // potential overlap prefix
  const text    = existingContent.slice(-limit);       // tail to search in

  // Build KMP failure function on (pattern + sentinel + text).
  // The value of f at the final position equals the longest prefix of
  // `pattern` that is simultaneously a suffix of `text` — the overlap length.
  const sep = "\x00"; // sentinel unlikely to appear in log bytes
  const s = pattern + sep + text;
  const f = new Int32Array(s.length);
  let k = 0;
  for (let i = 1; i < s.length; i++) {
    while (k > 0 && s.charCodeAt(i) !== s.charCodeAt(k)) k = f[k - 1];
    if (s.charCodeAt(i) === s.charCodeAt(k)) k++;
    f[i] = k;
  }
  return reconnectContent.slice(f[s.length - 1]);
}

/**
 * Stream pod logs with automatic reconnection. Keeps retrying the log
 * stream until the stop signal fires (job completed) or the container
 * exits normally. This handles silent K8s API connection drops that
 * would otherwise cause the UI to stop receiving real output.
 *
 * On reconnects, content is buffered rather than emitted directly.
 * findNewLogContent then strips any overlap introduced by sinceSeconds,
 * and only the genuinely new bytes are forwarded to onLog.  This is the
 * definitive fix for FAR-105 duplicate log output.
 *
 * Capped at MAX_LOG_RECONNECT_ATTEMPTS to prevent infinite reconnect
 * loops during sustained API partitions.
 */
async function streamPodLogs(
  namespace: string,
  podName: string,
  onLog: AdapterExecutionContext["onLog"],
  kubeconfigPath?: string,
  stopSignal?: { stopped: boolean },
): Promise<string> {
  let accumulated = ""; // all log content received and emitted so far
  let attempt = 0;
  // Updated per-chunk (inside callbacks) so it reflects when the last
  // byte of log data actually arrived, not when the stream object closed.
  let lastLogReceivedAt = Math.floor(Date.now() / 1000);

  while (!stopSignal?.stopped) {
    if (attempt >= MAX_LOG_RECONNECT_ATTEMPTS) {
      await onLog("stderr", `[paperclip] Log stream: max reconnect attempts (${MAX_LOG_RECONNECT_ATTEMPTS}) reached — giving up.\n`);
      break;
    }

    // On reconnect, ask for logs since the last received chunk (+5s buffer)
    // to avoid missing output produced during the reconnect gap.
    const sinceSeconds = attempt > 0
      ? Math.max(1, Math.floor(Date.now() / 1000) - lastLogReceivedAt + 5)
      : undefined;

    if (attempt > 0) {
      await onLog("stdout", `[paperclip] Log stream disconnected — reconnecting (attempt ${attempt}/${MAX_LOG_RECONNECT_ATTEMPTS})...\n`);
    }

    if (attempt === 0) {
      // First attempt: emit chunks to onLog in real-time and track content.
      const trackingOnLog: typeof onLog = async (stream, chunk) => {
        accumulated += chunk;
        lastLogReceivedAt = Math.floor(Date.now() / 1000);
        return onLog(stream, chunk);
      };
      await streamPodLogsOnce(namespace, podName, trackingOnLog, kubeconfigPath, undefined);
    } else {
      // Reconnect: buffer all chunks received from this stream attempt.
      // The sinceSeconds window means the stream begins with content that
      // was already emitted — we must not forward those bytes again.
      const reconnectChunks: string[] = [];
      const bufferingLog: typeof onLog = async (_stream, chunk) => {
        reconnectChunks.push(chunk);
        lastLogReceivedAt = Math.floor(Date.now() / 1000);
      };
      await streamPodLogsOnce(namespace, podName, bufferingLog, kubeconfigPath, sinceSeconds);

      const reconnectContent = reconnectChunks.join("");
      if (reconnectContent) {
        // Strip the overlapping prefix (already-sent content) and emit only
        // what extends beyond what the UI has already seen.
        const newContent = findNewLogContent(accumulated, reconnectContent);
        accumulated += newContent;
        if (newContent) {
          await onLog("stdout", newContent);
        }
      }
    }

    attempt++;

    // If the job is done or the container exited, no need to reconnect.
    if (stopSignal?.stopped) break;

    // Brief pause before reconnecting to avoid tight loops.
    await new Promise((resolve) => setTimeout(resolve, LOG_STREAM_RECONNECT_DELAY_MS));
  }

  return accumulated;
}

/**
 * One-shot read of pod logs (no follow). Used as fallback when the
 * follow stream missed output because the container exited quickly.
 */
async function readPodLogs(
  namespace: string,
  podName: string,
  kubeconfigPath?: string,
): Promise<string> {
  const coreApi = getCoreApi(kubeconfigPath);
  try {
    const log = await coreApi.readNamespacedPodLog({
      name: podName,
      namespace,
      container: "claude",
    });
    return typeof log === "string" ? log : "";
  } catch {
    return "";
  }
}

/**
 * Wait for the Job to reach a terminal state (Complete or Failed).
 * Returns the Job's final status.
 */
async function waitForJobCompletion(
  namespace: string,
  jobName: string,
  timeoutMs: number,
  kubeconfigPath?: string,
): Promise<{ succeeded: boolean; timedOut: boolean }> {
  const batchApi = getBatchApi(kubeconfigPath);
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : 0;

  while (deadline === 0 || Date.now() < deadline) {
    const job = await batchApi.readNamespacedJob({ name: jobName, namespace });
    const conditions = job.status?.conditions ?? [];

    const complete = conditions.find((c) => c.type === "Complete" && c.status === "True");
    if (complete) return { succeeded: true, timedOut: false };

    const failed = conditions.find((c) => c.type === "Failed" && c.status === "True");
    if (failed) {
      const isDeadlineExceeded = failed.reason === "DeadlineExceeded";
      return { succeeded: false, timedOut: isDeadlineExceeded };
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  return { succeeded: false, timedOut: true };
}

/**
 * Get the exit code from the Job's pod.
 */
async function getPodExitCode(namespace: string, jobName: string, kubeconfigPath?: string): Promise<number | null> {
  const coreApi = getCoreApi(kubeconfigPath);
  const podList = await coreApi.listNamespacedPod({
    namespace,
    labelSelector: `job-name=${jobName}`,
  });
  const pod = podList.items[0];
  if (!pod) return null;

  const containerStatus = pod.status?.containerStatuses?.find((s) => s.name === "claude");
  return containerStatus?.state?.terminated?.exitCode ?? null;
}

/**
 * Delete Job and its pods. Best-effort — failures are logged but not thrown.
 */
async function cleanupJob(
  namespace: string,
  jobName: string,
  onLog: AdapterExecutionContext["onLog"],
  kubeconfigPath?: string,
): Promise<void> {
  try {
    const batchApi = getBatchApi(kubeconfigPath);
    await batchApi.deleteNamespacedJob({
      name: jobName,
      namespace,
      body: { propagationPolicy: "Background" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await onLog("stderr", `[paperclip] Warning: failed to cleanup job ${jobName}: ${msg}\n`);
  }
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, runtime, config: rawConfig, onLog, onMeta } = ctx;
  const config = parseObject(rawConfig);
  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 60);
  const retainJobs = asBoolean(config.retainJobs, false);
  const kubeconfigPath = asString(config.kubeconfig, "") || undefined;

  // Guard: claude_k8s must not run concurrently for the same agent (shared PVC/session).
  // After a server restart, orphaned K8s Jobs from previous (now-failed) runs may
  // still be running.  We detect those by comparing the Job's run-id label against
  // the current runId and clean them up so this execution can proceed.
  const agentId = ctx.agent.id;
  const selfPod = await getSelfPodInfo(kubeconfigPath);
  const guardNamespace = asString(config.namespace, "") || selfPod.namespace;
  try {
    const batchApi = getBatchApi(kubeconfigPath);
    const existing = await batchApi.listNamespacedJob({
      namespace: guardNamespace,
      labelSelector: `paperclip.io/agent-id=${agentId},paperclip.io/adapter-type=claude_k8s`,
    });
    const running = existing.items.filter(
      (j) => !j.status?.conditions?.some((c) => (c.type === "Complete" || c.type === "Failed") && c.status === "True"),
    );
    if (running.length > 0) {
      // Separate orphaned jobs (from a previous server-side run) from truly
      // concurrent jobs (same runId — shouldn't happen but guard defensively).
      const orphaned = running.filter(
        (j) => (j.metadata?.labels?.["paperclip.io/run-id"] ?? "") !== runId,
      );
      const samRun = running.filter(
        (j) => (j.metadata?.labels?.["paperclip.io/run-id"] ?? "") === runId,
      );

      if (orphaned.length > 0) {
        const orphanNames = orphaned.map((j) => j.metadata?.name).join(", ");
        await onLog("stdout", `[paperclip] Cleaning up ${orphaned.length} orphaned K8s Job(s) from previous run(s): ${orphanNames}\n`);
        for (const j of orphaned) {
          const name = j.metadata?.name;
          if (name) {
            await cleanupJob(guardNamespace, name, onLog, kubeconfigPath);
          }
        }
      }

      // If there are still running Jobs that belong to THIS run (shouldn't happen
      // since we haven't created the Job yet), block execution.
      if (samRun.length > 0) {
        const names = samRun.map((j) => j.metadata?.name).join(", ");
        await onLog("stderr", `[paperclip] Concurrent run blocked: existing Job(s) still running for this run: ${names}\n`);
        return {
          exitCode: null,
          signal: null,
          timedOut: false,
          errorMessage: `Concurrent run blocked: Job ${names} is still running for this agent`,
          errorCode: "k8s_concurrent_run_blocked",
        };
      }
    }
  } catch (err: unknown) {
    // If we can't list jobs, fail closed — the K8s concurrency guard is the
    // only thing preventing zombie Jobs on a shared PVC from corrupting
    // sessions.  404 (namespace not found) is treated as a hard failure;
    // other errors (5xx, network) are also surfaced.
    const msg = err instanceof Error ? err.message : String(err);
    await onLog("stderr", `[paperclip] Concurrency guard failed: unable to list jobs: ${msg}\n`);
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      errorMessage: `Concurrency guard unreachable: ${msg}`,
      errorCode: "k8s_concurrency_guard_unreachable",
    };
  }

  // Build Job manifest
  const { job, jobName, namespace, prompt, claudeArgs, promptMetrics, promptSecret } = buildJobManifest({
    ctx,
    selfPod,
  });

  // Report invocation metadata
  if (onMeta) {
    await onMeta({
      adapterType: "claude_k8s",
      command: `kubectl job/${jobName}`,
      cwd: namespace,
      commandArgs: claudeArgs,
      commandNotes: [
        `Image: ${job.spec?.template.spec?.containers[0]?.image ?? "unknown"}`,
        `Namespace: ${namespace}`,
        `Timeout: ${timeoutSec}s`,
      ],
      prompt,
      ...(promptMetrics ? { promptMetrics } : {}),
      context: ctx.context,
    } as Parameters<typeof onMeta>[0]);
  }

  // If the prompt is large, create a Secret to hold it (avoids the ~1 MiB
  // PodSpec limit).  The Secret is cleaned up in the finally block.
  const coreApi = getCoreApi(kubeconfigPath);
  if (promptSecret) {
    try {
      await coreApi.createNamespacedSecret({
        namespace: promptSecret.namespace,
        body: {
          apiVersion: "v1",
          kind: "Secret",
          metadata: {
            name: promptSecret.name,
            namespace: promptSecret.namespace,
            labels: {
              "app.kubernetes.io/managed-by": "paperclip",
              "paperclip.io/adapter-type": "claude_k8s",
              "paperclip.io/run-id": runId,
            },
          },
          stringData: promptSecret.data,
        },
      });
      await onLog("stdout", `[paperclip] Created prompt Secret: ${promptSecret.name} (${Math.round(Buffer.byteLength(prompt, "utf-8") / 1024)} KiB)\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await onLog("stderr", `[paperclip] Failed to create prompt Secret: ${msg}\n`);
      return {
        exitCode: null,
        signal: null,
        timedOut: false,
        errorMessage: `Failed to create prompt Secret: ${msg}`,
        errorCode: "k8s_prompt_secret_create_failed",
      };
    }
  }

  // Create the Job
  const batchApi = getBatchApi(kubeconfigPath);
  try {
    await batchApi.createNamespacedJob({ namespace, body: job });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await onLog("stderr", `[paperclip] Failed to create K8s Job: ${msg}\n`);
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      errorMessage: `Failed to create Kubernetes Job: ${msg}`,
      errorCode: "k8s_job_create_failed",
    };
  }

  await onLog("stdout", `[paperclip] Created K8s Job: ${jobName} in namespace ${namespace} (deadline: ${timeoutSec > 0 ? `${timeoutSec}s` : "none"})\n`);

  let stdout = "";
  let exitCode: number | null = null;
  let jobTimedOut = false;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  // Set when we return a mismatch error so the finally block knows not to
  // delete a job that is still alive and the UI is waiting on.
  let skipCleanup = false;

  try {
    // Wait for pod to be ready for log streaming
    const scheduleTimeoutMs = 120_000; // 2 minutes for scheduling
    let podName: string;
    try {
      podName = await waitForPod(namespace, jobName, scheduleTimeoutMs, onLog, kubeconfigPath);
      await onLog("stdout", `[paperclip] Pod running: ${podName}\n`);

      // Notify the server that execution has started.  This sets
      // processStartedAt and refreshes updatedAt in the DB, which the
      // stale-run reaper (reapOrphanedRuns) uses to decide liveness.
      if (ctx.onSpawn) {
        await ctx.onSpawn({
          pid: -1,              // no local process; sentinel for K8s Job
          processGroupId: null,
          startedAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await onLog("stderr", `[paperclip] Pod scheduling failed: ${msg}\n`);
      return {
        exitCode: null,
        signal: null,
        timedOut: false,
        errorMessage: `Pod scheduling failed: ${msg}`,
        errorCode: "k8s_pod_schedule_failed",
      };
    }

    // Stream logs and wait for completion concurrently.
    // The log stream will end when the container exits.
    // We also poll the Job status to detect deadline exceeded.
    // 0 = no timeout (run indefinitely, matching claude_local behavior)
    const completionTimeoutMs = timeoutSec > 0 ? (timeoutSec + graceSec) * 1000 : 0;

    // Keepalive: periodically send a status line via onLog so the
    // Paperclip server knows the adapter is still alive even when the
    // pod produces no output (e.g. Claude is in a long thinking phase).
    //
    // IMPORTANT: onLog alone does NOT update the run's updatedAt in the
    // DB — it only appends to the log store and publishes SSE events.
    // The stale-run reaper checks updatedAt, so we must also call
    // onSpawn periodically to refresh it.  Without this, multi-instance
    // deployments can reap a live run from another server instance
    // after the 5-minute staleness window.
    //
    // BUT: the keepalive must NEVER refresh updatedAt if the underlying
    // K8s Job is already terminal.  Otherwise, if execute() stalls after
    // the pod finishes (e.g. a slow K8s API call, a hung log stream
    // drain, or a Job whose Complete condition lags pod termination),
    // we would keep the run marked "alive" indefinitely while the pod
    // is actually gone — the exact "UI thinks jobs are running when
    // they are not" bug.  We verify Job liveness every tick and stop
    // refreshing as soon as the Job reaches a terminal state; if
    // execute() is truly stuck, the reaper will then catch it within
    // the normal 5-minute staleness window.
    let lastLogAt = Date.now();
    let keepaliveTick = 0;
    let keepaliveJobTerminal = false;
    keepaliveTimer = setInterval(() => {
      // Fire-and-forget the async work; setInterval callbacks must be
      // synchronous or the timer will drift.
      void (async () => {
        if (keepaliveJobTerminal) return;

        // Verify the Job is still alive before announcing or refreshing.
        try {
          const job = await batchApi.readNamespacedJob({ name: jobName, namespace });
          const terminal = job.status?.conditions?.some(
            (c) => (c.type === "Complete" || c.type === "Failed") && c.status === "True",
          );
          if (terminal) {
            keepaliveJobTerminal = true;
            return;
          }
        } catch (err: unknown) {
          // Only treat 404 (Job deleted) as terminal.  Transient 5xx or
          // connection resets should NOT permanently disable the keepalive —
          // the next tick will re-check and the reaper uses the staleness
          // window as a safety net.
          const statusCode = (err as { response?: { statusCode?: number } })?.response?.statusCode
            ?? (err as { statusCode?: number })?.statusCode;
          if (statusCode === 404) {
            keepaliveJobTerminal = true;
            return;
          }
          // Log transient errors but leave keepaliveJobTerminal false so
          // the next tick retries.
          const msg = err instanceof Error ? err.message : String(err);
          void onLog("stderr", `[paperclip] keepalive: transient error checking job status: ${msg}\n`).catch(() => {});
          return;
        }

        const silenceSec = Math.round((Date.now() - lastLogAt) / 1000);
        void onLog("stdout", `[paperclip] keepalive — job ${jobName} running (${silenceSec}s since last output)\n`).catch(() => {});

        // Refresh updatedAt every ~3 minutes (12 ticks × 15s = 180s) to
        // stay well within the 5-minute reaper staleness window.  Also
        // fire on tick 1 for an early safety margin after job start.
        keepaliveTick++;
        if (ctx.onSpawn && (keepaliveTick === 1 || keepaliveTick % 12 === 0)) {
          void ctx.onSpawn({ pid: -1, processGroupId: null, startedAt: new Date().toISOString() }).catch(() => {});
        }
      })();
    }, KEEPALIVE_INTERVAL_MS);
    const wrappedOnLog: typeof onLog = async (stream, chunk) => {
      lastLogAt = Date.now();
      return onLog(stream, chunk);
    };

    // Shared signal: when job completion resolves, tell the log
    // streamer to stop reconnecting.
    const logStopSignal = { stopped: false };

    const [logResult, completionResult] = await Promise.allSettled([
      streamPodLogs(namespace, podName, wrappedOnLog, kubeconfigPath, logStopSignal),
      waitForJobCompletion(namespace, jobName, completionTimeoutMs, kubeconfigPath).then((r) => {
        logStopSignal.stopped = true;
        return r;
      }),
    ]);

    // Stop the keepalive immediately once the job has reached a terminal
    // state — do not wait for the finally block.  Any K8s API call or
    // cleanup that happens after this point should not keep the run
    // marked "alive" in the DB via onSpawn refreshes.
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }

    if (logResult.status === "fulfilled") {
      stdout = logResult.value;
    }

    // If the follow stream missed output (container exited quickly), do a
    // one-shot log read as fallback before the pod is cleaned up.
    if (!stdout.trim()) {
      await onLog("stdout", `[paperclip] Log stream returned empty — reading pod logs directly...\n`);
      stdout = await readPodLogs(namespace, podName, kubeconfigPath);
      if (stdout.trim()) {
        await onLog("stdout", stdout);
      }
    }

    if (completionResult.status === "fulfilled") {
      jobTimedOut = completionResult.value.timedOut;
    } else {
      // waitForJobCompletion threw — re-check job state to avoid returning
      // while the job is still running (which would cause UI staleness and
      // concurrency errors on retry).  Use a bounded timeout (60s) so we
      // don't hang the heartbeat indefinitely if the K8s API is degraded.
      jobTimedOut = false;
      const RECHECK_TIMEOUT_MS = 60_000;
      const actualState = await waitForJobCompletion(namespace, jobName, RECHECK_TIMEOUT_MS, kubeconfigPath);
      if (actualState.timedOut) {
        // Re-check itself timed out — the job may still be running.
        // Return an error so the UI knows the run is not done.
        jobTimedOut = true;
      } else if (!actualState.succeeded) {
        // Job still not terminal — the completion error was likely transient.
        // Return an error so the UI knows the run is not done, rather than
        // returning with parsed (potentially incomplete) stdout.
        await onLog("stderr", `[paperclip] Job ${jobName} still not terminal after log/completion mismatch — returning error to keep UI in sync.\n`);
        skipCleanup = true;
        return {
          exitCode,
          signal: null,
          timedOut: false,
          errorMessage: `Job ${jobName} did not complete cleanly (log stream ended before job reached terminal state)`,
          errorCode: "k8s_job_state_mismatch",
        };
      }
    }

    exitCode = await getPodExitCode(namespace, jobName, kubeconfigPath);
  } finally {
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    if (skipCleanup) {
      await onLog("stdout", `[paperclip] Retaining job ${jobName} (state mismatch — UI is waiting on it)\n`);
    } else if (!retainJobs) {
      await cleanupJob(namespace, jobName, onLog, kubeconfigPath);
    } else {
      await onLog("stdout", `[paperclip] Retaining job ${jobName} for debugging (retainJobs=true)\n`);
    }
    // Clean up prompt Secret if one was created
    if (promptSecret) {
      try {
        await coreApi.deleteNamespacedSecret({ name: promptSecret.name, namespace: promptSecret.namespace });
      } catch {
        // Best-effort cleanup — TTL or manual deletion will catch stragglers
      }
    }
  }

  // Parse Claude output (reuse claude_local parsing)
  if (jobTimedOut) {
    return {
      exitCode,
      signal: null,
      timedOut: true,
      errorMessage: `Timed out after ${timeoutSec}s`,
      errorCode: "timeout",
    };
  }

  const parsedStream = parseClaudeStreamJson(stdout);
  const parsed = parsedStream.resultJson;

  // If the session was stale, clear it so the next heartbeat starts fresh
  if (parsed && (exitCode ?? 0) !== 0 && isClaudeUnknownSessionError(parsed)) {
    await onLog("stdout", `[paperclip] Claude session is unavailable; clearing for next run.\n`);
    return {
      exitCode,
      signal: null,
      timedOut: false,
      errorMessage: describeClaudeFailure(parsed) ?? "Session unavailable",
      errorCode: "session_unavailable",
      clearSession: true,
      resultJson: parsed,
    };
  }

  if (!parsed) {
    const stderrLine = stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
    return {
      exitCode,
      signal: null,
      timedOut: false,
      errorMessage: exitCode === 0
        ? "Failed to parse Claude JSON output"
        : stderrLine
          ? `Claude exited with code ${exitCode ?? -1}: ${stderrLine}`
          : `Claude exited with code ${exitCode ?? -1}`,
      resultJson: { stdout },
    };
  }

  const usage = parsedStream.usage ?? (() => {
    const usageObj = parseObject(parsed.usage as Record<string, unknown>);
    return {
      inputTokens: asNumber(usageObj.input_tokens, 0),
      cachedInputTokens: asNumber(usageObj.cache_read_input_tokens, 0),
      outputTokens: asNumber(usageObj.output_tokens, 0),
    };
  })();

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const fallbackSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const resolvedSessionId = parsedStream.sessionId
    ?? (asString(parsed.session_id as string, fallbackSessionId) || fallbackSessionId);
  const model = asString(config.model, "");
  const workspaceContext = parseObject(ctx.context.paperclipWorkspace);
  const workspaceId = asString(workspaceContext.workspaceId, "") || null;
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "") || null;
  const workspaceRepoRef = asString(workspaceContext.repoRef, "") || null;
  const cwd = asString(workspaceContext.cwd, "");

  const resolvedSessionParams = resolvedSessionId
    ? {
        sessionId: resolvedSessionId,
        ...(cwd ? { cwd } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
        ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
      } as Record<string, unknown>
    : null;

  const clearSessionForMaxTurns = isClaudeMaxTurnsResult(parsed);

  return {
    exitCode,
    signal: null,
    timedOut: false,
    errorMessage:
      (exitCode ?? 0) === 0
        ? null
        : describeClaudeFailure(parsed) ?? `Claude exited with code ${exitCode ?? -1}`,
    usage,
    sessionId: resolvedSessionId || null,
    sessionParams: resolvedSessionParams,
    sessionDisplayId: resolvedSessionId || null,
    provider: "anthropic",
    model: parsedStream.model || asString(parsed.model as string, model),
    billingType: "api",
    costUsd: parsedStream.costUsd ?? asNumber(parsed.total_cost_usd, 0),
    resultJson: parsed,
    summary: parsedStream.summary || asString(parsed.result as string, ""),
    clearSession: clearSessionForMaxTurns,
  } as AdapterExecutionResult;
}
