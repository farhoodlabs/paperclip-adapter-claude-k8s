import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  asBoolean,
  parseObject,
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import fs from "node:fs/promises";
import path from "node:path";
import { prepareClaudePromptBundle } from "./prompt-cache.js";
import {
  parseClaudeStreamJson,
  describeClaudeFailure,
  isClaudeMaxTurnsResult,
  isClaudeUnknownSessionError,
} from "./parse.js";
import { getSelfPodInfo, getBatchApi, getCoreApi, getLogApi } from "./k8s-client.js";
import { buildJobManifest, sanitizeLabelValue } from "./job-manifest.js";
import { LogLineDedupFilter } from "./log-dedup.js";
import type * as k8s from "@kubernetes/client-node";
import { Writable } from "node:stream";

const POLL_INTERVAL_MS = 2000;
const KEEPALIVE_INTERVAL_MS = 15_000;
const LOG_STREAM_RECONNECT_DELAY_MS = 3_000;
const MAX_LOG_RECONNECT_ATTEMPTS = 50;
// Upper bound on how long streamPodLogsOnce will wait after stopSignal fires
// before force-returning, even if logApi.log has not yet resolved.  Defensive
// against the K8s client library not propagating writable.destroy() into an
// abort of the underlying HTTP request.
const LOG_STREAM_BAIL_TIMEOUT_MS = 3_000;
// After the log stream exits (container stopped producing output), wait this
// long for the K8s Job condition to be confirmed before treating the job as
// done.  K8s Job conditions can lag pod exit by several seconds or more under
// cluster load.  Without this bound, waitForJobCompletion keeps polling while
// streamPodLogs keeps reconnecting — together they can hold execute() open for
// minutes, causing stale "running" status in the UI (FAR-23).
const LOG_EXIT_COMPLETION_GRACE_MS = 30_000;

// Module-level tracking of active Jobs for SIGTERM best-effort cleanup.
interface ActiveJobRef {
  namespace: string;
  jobName: string;
  promptSecretName?: string;
  promptSecretNamespace?: string;
  kubeconfigPath?: string;
}
const activeJobs = new Set<ActiveJobRef>();
// Per-agent serialization lock: prevents the TOCTOU race (FAR-29) where two
// concurrent execute() calls for the same agent both pass the list-then-create
// guard and create K8s Jobs simultaneously on the shared PVC.
const agentCreationMutex = new Map<string, Promise<void>>();
let sigtermHandlerRegistered = false;

function ensureSigtermHandler(): void {
  if (sigtermHandlerRegistered) return;
  sigtermHandlerRegistered = true;
  process.once("SIGTERM", () => {
    const jobs = [...activeJobs];
    void Promise.allSettled(
      jobs.map(async (ref) => {
        try {
          const batchApi = getBatchApi(ref.kubeconfigPath);
          await batchApi.deleteNamespacedJob({
            name: ref.jobName,
            namespace: ref.namespace,
            body: { propagationPolicy: "Background" },
          });
        } catch { /* best-effort */ }
        if (ref.promptSecretName && ref.promptSecretNamespace) {
          try {
            const coreApi = getCoreApi(ref.kubeconfigPath);
            await coreApi.deleteNamespacedSecret({
              name: ref.promptSecretName,
              namespace: ref.promptSecretNamespace,
            });
          } catch { /* best-effort */ }
        }
      }),
    ).then(() => {
      process.kill(process.pid, "SIGTERM");
    });
  });
}

/**
 * Detect a Kubernetes 404 (Not Found) error from @kubernetes/client-node.
 * Works for both v0.x (response.statusCode) and v1.0+ (response.status, message).
 * Exported for unit tests.
 */
export function isK8s404(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as unknown as Record<string, unknown>;
  const resp = e.response as Record<string, unknown> | undefined;
  if (resp?.statusCode === 404 || resp?.status === 404) return true;
  if (e.statusCode === 404) return true;
  return /HTTP-Code:\s*404\b/.test(err.message);
}

/**
 * Returns true when the heartbeat-run status indicates the run is no longer
 * active and the K8s Job should be cancelled.
 * Exported for unit tests.
 */
export function shouldAbortForCancellation(runStatus: string | undefined): boolean {
  if (!runStatus) return false;
  return runStatus !== "running";
}

/**
 * Build the error message when Claude's stdout contains no result event.
 * Skips system/init event lines so the UI doesn't display the raw init JSON.
 * Exported for unit tests.
 */
export function buildPartialRunError(
  exitCode: number | null,
  model: string,
  stdout: string,
): string {
  if (exitCode === 0) return "Failed to parse Claude JSON output";

  // Walk stdout lines and skip every structured streaming event (any JSON
  // object that carries a non-empty "type" field: system, assistant, user,
  // rate_limit_event, result, …).  All of these are protocol artefacts and
  // produce confusing raw-JSON blobs when surfaced verbatim as an error
  // message.  Only plain-text lines (non-JSON, or JSON without a type field)
  // are treated as human-readable content worth including in the error.
  const firstContentLine = stdout.split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => {
      if (!l) return false;
      try {
        const obj = JSON.parse(l);
        if (typeof obj === "object" && obj !== null) {
          const t = (obj as Record<string, unknown>).type;
          if (typeof t === "string" && t) return false;
        }
      } catch {
        // not JSON — treat as content
      }
      return true;
    }) ?? "";

  // If the stream contained only structured events with no plain-text output,
  // surface the model name so the operator can diagnose missing credentials
  // or unsupported/misconfigured model.
  const initOnlyOutput = stdout.trim() !== "" && model !== "" && !firstContentLine;
  if (initOnlyOutput) {
    const modelHint = model ? ` (model: ${model})` : "";
    return `Claude started but did not produce a result${modelHint} — check API credentials, model support, and adapter config`;
  }

  return firstContentLine
    ? `Claude exited with code ${exitCode ?? -1}: ${firstContentLine}`
    : `Claude exited with code ${exitCode ?? -1}`;
}

export type OrphanClassification =
  | "reattach"
  | "block_session_mismatch"
  | "block_task_mismatch"
  | "block_task_unknown";

/**
 * Classify a non-terminal orphaned K8s Job (one whose `paperclip.io/run-id`
 * label does not match the current runId but does belong to this agent) as a
 * reattach candidate or a block reason.
 *
 * Decision matrix:
 *   - taskId mismatch (both present, different values)         → block_task_mismatch
 *   - taskId missing on either side                            → block_task_unknown
 *   - taskId match + both have sessionId + sessionIds differ   → block_session_mismatch
 *   - taskId match + one or both sides missing sessionId       → reattach (reconcile)
 *   - taskId match + both have sessionId + sessionIds match    → reattach (happy path)
 *
 * Exported for unit tests.
 */
export function classifyOrphan(
  job: k8s.V1Job,
  expected: { taskId: string | null; sessionId: string | null },
): OrphanClassification {
  const labels = job.metadata?.labels ?? {};
  const jobTaskId = labels["paperclip.io/task-id"] ?? null;
  const jobSessionId = labels["paperclip.io/session-id"] ?? null;

  // taskId missing on either side
  if (!expected.taskId || !jobTaskId) return "block_task_unknown";

  // taskId mismatch
  if (expected.taskId !== jobTaskId) return "block_task_mismatch";

  // taskId matches — check sessionId
  if (expected.sessionId && jobSessionId && expected.sessionId !== jobSessionId) {
    return "block_session_mismatch";
  }

  return "reattach";
}

/**
 * Build an error message for a pod that reached phase=Failed before or
 * instead of streaming logs. Includes the claude container's terminated exit
 * code and reason when available so operators can diagnose crashes without
 * needing kubectl.  Exported for unit tests.
 */
export function describePodTerminatedError(
  podName: string,
  phase: string,
  containerStatuses: k8s.V1ContainerStatus[],
): string {
  const mainCs = containerStatuses.find((cs) => cs.name === "claude");
  const terminated = mainCs?.state?.terminated;
  if (terminated) {
    const code = terminated.exitCode ?? "unknown";
    const reason = terminated.reason ?? terminated.message ?? "no reason";
    return `Pod ${podName} reached phase=${phase}: claude exited ${code} (${reason})`;
  }
  return `Pod ${podName} reached phase=${phase}`;
}

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
    const statusKey = `${phase}:${initStatuses.map((s) => s.state?.waiting?.reason ?? s.state?.terminated?.reason ?? "ok").join(",")}:${containerStatuses.map((s) => s.state?.waiting?.reason ?? (s.state?.running ? "running" : "waiting")).join(",")}`;
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
        else if (cs.state?.terminated) details.push(`${cs.name}: terminated (exit ${cs.state.terminated.exitCode ?? "?"}, ${cs.state.terminated.reason ?? "no reason"})`);
      }
      await onLog("stdout", `[paperclip] Pod ${podName}: ${details.join(", ")}\n`);
      lastStatus = statusKey;
    }

    // Ready to stream logs
    if (phase === "Running" || phase === "Succeeded") {
      return podName;
    }
    // phase=Failed means the pod crashed before we could stream logs.
    // Throwing here routes the caller into the error path with a structured
    // message instead of entering the log-streaming path with a dead pod.
    if (phase === "Failed") {
      throw new Error(describePodTerminatedError(podName, phase, containerStatuses));
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
export async function streamPodLogsOnce(
  namespace: string,
  podName: string,
  onLog: AdapterExecutionContext["onLog"],
  kubeconfigPath?: string,
  sinceSeconds?: number,
  dedup?: LogLineDedupFilter,
  stopSignal?: { stopped: boolean },
): Promise<string> {
  const logApi = getLogApi(kubeconfigPath);
  const chunks: string[] = [];

  const writable = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const text = chunk.toString("utf-8");
      chunks.push(text);
      const emitted = dedup ? dedup.filter(text) : text;
      if (!emitted) {
        callback();
        return;
      }
      // Forward raw stream-json lines unchanged.  The Paperclip UI uses the
      // adapter's ui-parser export (src/ui-parser.ts) to render structured
      // transcript entries — pre-formatting here would strip that structure
      // and produce flat plain text that looks nothing like claude_local.
      void onLog("stdout", emitted).then(() => callback(), callback);
    },
  });

  // When the job completion signal fires, destroy the writable to abort the
  // in-flight follow stream.  Without this, logApi.log can hang indefinitely
  // when the pod terminates without closing the HTTP connection cleanly.
  let stopPoller: ReturnType<typeof setInterval> | null = null;
  let bailTimer: ReturnType<typeof setTimeout> | null = null;
  let bailResolve: (() => void) | null = null;
  // Bail promise resolves LOG_STREAM_BAIL_TIMEOUT_MS after stopSignal fires,
  // even if logApi.log has not resolved by then.  This is a safety net for the
  // case where writable.destroy() fails to propagate to an abort of the HTTP
  // request (e.g. the K8s client is awaiting a response that never comes).
  const bailPromise = new Promise<void>((resolve) => {
    bailResolve = resolve;
  });
  if (stopSignal) {
    stopPoller = setInterval(() => {
      if (stopSignal.stopped) {
        if (!writable.destroyed) writable.destroy();
        if (!bailTimer && bailResolve) {
          bailTimer = setTimeout(() => {
            onLog("stderr", "[paperclip] Log stream bail timer fired — forcing return\n").catch(() => {});
            bailResolve!();
          }, LOG_STREAM_BAIL_TIMEOUT_MS);
        }
      }
    }, 200);
  }

  const logPromise = logApi.log(namespace, podName, "claude", writable, {
    follow: true,
    pretty: false,
    ...(sinceSeconds ? { sinceSeconds } : {}),
  }).catch(() => {
    // follow may fail if the container already exited, the API connection
    // dropped, or we aborted via writable.destroy() — not fatal.
  });

  try {
    if (stopSignal) {
      await Promise.race([logPromise, bailPromise]);
    } else {
      await logPromise;
    }
  } finally {
    if (stopPoller) clearInterval(stopPoller);
    if (bailTimer) clearTimeout(bailTimer);
  }

  return chunks.join("");
}

/**
 * Stream pod logs with automatic reconnection. Keeps retrying the log
 * stream until the stop signal fires (job completed) or the container
 * exits normally. This handles silent K8s API connection drops that
 * would otherwise cause the UI to stop receiving real output.
 *
 * Capped at MAX_LOG_RECONNECT_ATTEMPTS to prevent infinite reconnect
 * loops during sustained API partitions.
 *
 * onFirstStreamExit is called the first time streamPodLogsOnce returns
 * (container has exited or stream disconnected). Used by execute() to
 * start the LOG_EXIT_COMPLETION_GRACE_MS grace timer (FAR-23) without
 * waiting for all reconnects to exhaust.
 */
async function streamPodLogs(
  namespace: string,
  podName: string,
  onLog: AdapterExecutionContext["onLog"],
  kubeconfigPath?: string,
  stopSignal?: { stopped: boolean },
  dedup?: LogLineDedupFilter,
  onFirstStreamExit?: () => void,
): Promise<string> {
  const allChunks: string[] = [];
  let attempt = 0;
  // Track the timestamp of the last successfully received log line so
  // reconnects use a tight window instead of an ever-growing one anchored
  // at stream start.  This is the primary fix for FAR-105 duplicative logs.
  let lastLogReceivedAt = Math.floor(Date.now() / 1000);
  // Shared across reconnects so replayed lines inside the `sinceSeconds`
  // overlap window are dropped before they reach the streaming UI (FAR-123).
  if (!dedup) dedup = new LogLineDedupFilter();

  while (!stopSignal?.stopped) {
    if (attempt >= MAX_LOG_RECONNECT_ATTEMPTS) {
      await onLog("stderr", `[paperclip] Log stream: max reconnect attempts (${MAX_LOG_RECONNECT_ATTEMPTS}) reached — giving up.\n`);
      break;
    }

    // On reconnect, ask for logs since the last received line (+5s buffer)
    // instead of since stream start.  This keeps the window tight and
    // avoids ever-growing duplicate output.
    const sinceSeconds = attempt > 0
      ? Math.max(1, Math.floor(Date.now() / 1000) - lastLogReceivedAt + 5)
      : undefined;

    if (attempt > 0) {
      await onLog("stdout", `[paperclip] Log stream disconnected — reconnecting (attempt ${attempt}/${MAX_LOG_RECONNECT_ATTEMPTS})...\n`);
    }

    const preStreamTs = Math.floor(Date.now() / 1000);
    const result = await streamPodLogsOnce(namespace, podName, onLog, kubeconfigPath, sinceSeconds, dedup, stopSignal);
    // Signal first stream exit immediately so the grace-period timer in
    // execute() can start without waiting for all reconnects to complete.
    if (attempt === 0) onFirstStreamExit?.();
    if (result) {
      allChunks.push(result);
      // Update last-received timestamp to now (the stream just ended,
      // so any log lines in `result` were received up to this moment).
      lastLogReceivedAt = Math.floor(Date.now() / 1000);
    } else if (attempt === 0) {
      // First attempt returned nothing — update timestamp so reconnect
      // window stays reasonable.
      lastLogReceivedAt = preStreamTs;
    }
    attempt++;

    // If the job is done or the container exited, no need to reconnect.
    if (stopSignal?.stopped) break;

    // Brief pause before reconnecting to avoid tight loops.
    await new Promise((resolve) => setTimeout(resolve, LOG_STREAM_RECONNECT_DELAY_MS));
  }

  // Flush any buffered partial line so the final assistant/result chunk
  // isn't dropped when the stream ends mid-line.
  const tail = dedup.flush();
  if (tail) await onLog("stdout", tail);

  return allChunks.join("");
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
 * Returns the Job's final status.  A 404 (job deleted by TTL or externally)
 * is treated as a soft terminal: succeeded=false, timedOut=false, jobGone=true.
 * The caller should log this and fall through to stdout parsing.
 */
async function waitForJobCompletion(
  namespace: string,
  jobName: string,
  timeoutMs: number,
  kubeconfigPath?: string,
): Promise<{ succeeded: boolean; timedOut: boolean; jobGone?: boolean }> {
  const batchApi = getBatchApi(kubeconfigPath);
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : 0;

  while (deadline === 0 || Date.now() < deadline) {
    let job;
    try {
      job = await batchApi.readNamespacedJob({ name: jobName, namespace });
    } catch (err: unknown) {
      if (isK8s404(err)) {
        // Job was deleted (TTL garbage collection or external deletion) before
        // we detected its terminal condition.  The container must have already
        // exited for TTL to fire, so log streaming will have captured the output.
        return { succeeded: false, timedOut: false, jobGone: true };
      }
      throw err;
    }
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
  const state = await getPodTerminatedState(namespace, jobName, kubeconfigPath);
  return state?.exitCode ?? null;
}

/**
 * Get the claude container's terminated state (exit code, reason, message,
 * signal) from the Job's pod. Returns null if the pod or container is gone.
 * Used by the no-result error path to explain *why* a run was truncated.
 */
export interface PodTerminatedState {
  exitCode: number | null;
  reason: string | null;
  message: string | null;
  signal: number | null;
}

async function getPodTerminatedState(
  namespace: string,
  jobName: string,
  kubeconfigPath?: string,
): Promise<PodTerminatedState | null> {
  const coreApi = getCoreApi(kubeconfigPath);
  const podList = await coreApi.listNamespacedPod({
    namespace,
    labelSelector: `job-name=${jobName}`,
  });
  const pod = podList.items[0];
  if (!pod) return null;

  const containerStatus = pod.status?.containerStatuses?.find((s) => s.name === "claude");
  const terminated = containerStatus?.state?.terminated;
  if (!terminated) return null;
  return {
    exitCode: terminated.exitCode ?? null,
    reason: terminated.reason ?? null,
    message: (terminated.message ?? "").trim() || null,
    signal: terminated.signal ?? null,
  };
}

/**
 * Format a human-readable explanation for a truncated run, including the
 * pod's claude-container terminated state when available. Exit code 137
 * is annotated as SIGKILL/OOM since that is the most common cause.
 * Exported for unit tests.
 */
export function describeTruncationCause(
  state: PodTerminatedState | null,
): string {
  if (!state) {
    return "pod state unavailable — likely deleted before exit could be read";
  }
  const parts: string[] = [];
  if (state.exitCode !== null) {
    parts.push(`exit code ${state.exitCode}`);
    if (state.exitCode === 137) parts.push("SIGKILL (commonly OOMKilled)");
    else if (state.exitCode === 143) parts.push("SIGTERM");
  } else {
    parts.push("no exit code");
  }
  if (state.signal !== null) parts.push(`signal ${state.signal}`);
  if (state.reason) parts.push(`reason=${state.reason}`);
  if (state.message) parts.push(`message=${state.message}`);
  return parts.join(", ");
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
  const paperclipApiUrl = process.env.PAPERCLIP_API_URL ?? "";
  if (!paperclipApiUrl) {
    await onLog("stderr", "[paperclip] Warning: PAPERCLIP_API_URL not set — cancel polling disabled\n");
  }

  // Guard: claude_k8s must not run concurrently for the same agent (shared PVC/session).
  // After a server restart, orphaned K8s Jobs from previous (now-failed) runs may
  // still be running.  We detect those by comparing the Job's run-id label against
  // the current runId.  When reattachOrphanedJobs is enabled and the orphan matches
  // the current agent+task+session, we attach to it instead of deleting it (FAR-124).
  const agentId = ctx.agent.id;
  const sanitizedAgentId = sanitizeLabelValue(agentId);
  if (!sanitizedAgentId) {
    await onLog("stderr", `[paperclip] Cannot create K8s Job: agent.id "${agentId}" produces no valid RFC 1123 label characters\n`);
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      errorMessage: `Agent ID "${agentId}" cannot be sanitized to a valid Kubernetes label`,
      errorCode: "k8s_agent_id_invalid",
    };
  }
  // FAR-29: serialize guard+create per agent within this process to prevent the
  // TOCTOU race where two concurrent execute() calls both pass the list-then-create
  // guard and create K8s Jobs simultaneously on the shared PVC.
  const _prevCreation = agentCreationMutex.get(agentId) ?? Promise.resolve();
  let _releaseMutex: () => void = () => {};
  const _mutexSlot = new Promise<void>((resolve) => { _releaseMutex = resolve; });
  // Chain: next caller for this agent waits on _mutexSlot, which resolves in finally.
  agentCreationMutex.set(agentId, _prevCreation.then(() => _mutexSlot, () => _mutexSlot));
  // Wait for any prior execute() call to finish its guard+create phase.
  await _prevCreation.catch(() => {});

  // Hoist declarations used in both the guard+create phase and the log-streaming
  // section so the mutex try/finally can be added without a large re-indent.
  let reattachTarget: { jobName: string; namespace: string; priorRunId: string; image: string } | null = null;
  // eslint-disable-next-line prefer-const
  let jobName!: string;
  // eslint-disable-next-line prefer-const
  let namespace!: string;
  let promptSecret: { name: string; namespace: string; data: Record<string, string> } | null = null;
  // runtimeSessionParams and currentSessionIdRaw are also used after the
  // try block (in the result-parsing section) so hoist them here.
  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const currentSessionIdRaw = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const coreApi = getCoreApi(kubeconfigPath);
  const batchApi = getBatchApi(kubeconfigPath);

  try {
  const selfPod = await getSelfPodInfo(kubeconfigPath);
  const guardNamespace = asString(config.namespace, "") || selfPod.namespace;
  const reattachOrphanedJobs = asBoolean(config.reattachOrphanedJobs, true);
  const currentSessionLabel = currentSessionIdRaw ? sanitizeLabelValue(currentSessionIdRaw) : null;
  const currentTaskIdRaw = asString(ctx.context.taskId, "") || asString(ctx.context.issueId, "");
  const currentTaskLabel = currentTaskIdRaw ? sanitizeLabelValue(currentTaskIdRaw) : null;
  try {
    const existing = await batchApi.listNamespacedJob({
      namespace: guardNamespace,
      labelSelector: `paperclip.io/agent-id=${sanitizedAgentId},paperclip.io/adapter-type=claude_k8s`,
    });
    const running = existing.items.filter(
      (j) =>
        !j.metadata?.deletionTimestamp &&
        !j.status?.conditions?.some((c) => (c.type === "Complete" || c.type === "Failed") && c.status === "True"),
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
        if (!reattachOrphanedJobs) {
          // When reattach is disabled, block on any non-terminal orphan.
          const names = orphaned.map((j) => j.metadata?.name).join(", ");
          await onLog("stderr", `[paperclip] Concurrent run blocked: orphaned Job(s) running and reattach disabled: ${names}\n`);
          return {
            exitCode: null,
            signal: null,
            timedOut: false,
            errorMessage: `Concurrent run blocked: orphaned Job(s) still running for this agent (reattach disabled)`,
            errorCode: "k8s_concurrent_run_blocked",
          };
        }

        // Apply the decision matrix to each orphan, newest-first.  The first
        // reattachable orphan becomes the target; any block classification
        // stops the new run immediately.  Orphans are never deleted here —
        // terminal ones are cleaned up by TTL; live mismatches should not be
        // killed because they may still be doing real work.
        const sortedOrphans = [...orphaned].sort((a, b) => {
          const at = new Date(a.metadata?.creationTimestamp ?? 0).getTime();
          const bt = new Date(b.metadata?.creationTimestamp ?? 0).getTime();
          return bt - at;
        });
        for (const orphan of sortedOrphans) {
          const classification = classifyOrphan(orphan, {
            taskId: currentTaskLabel,
            sessionId: currentSessionLabel,
          });
          const orphanName = orphan.metadata?.name ?? "unknown";
          if (classification === "reattach") {
            if (!reattachTarget) {
              reattachTarget = {
                jobName: orphanName,
                namespace: orphan.metadata?.namespace ?? guardNamespace,
                priorRunId: orphan.metadata?.labels?.["paperclip.io/run-id"] ?? "",
                image: orphan.spec?.template?.spec?.containers?.[0]?.image ?? "unknown",
              };
            }
          } else if (classification === "block_task_unknown") {
            await onLog("stderr", `[paperclip] Blocked: orphaned Job ${orphanName} has missing task label — cannot safely reattach\n`);
            return {
              exitCode: null,
              signal: null,
              timedOut: false,
              errorMessage: `Concurrent run blocked: orphaned Job ${orphanName} has unknown task context`,
              errorCode: "k8s_orphan_task_unknown",
            };
          } else if (classification === "block_task_mismatch") {
            await onLog("stderr", `[paperclip] Blocked: orphaned Job ${orphanName} belongs to a different task\n`);
            return {
              exitCode: null,
              signal: null,
              timedOut: false,
              errorMessage: `Concurrent run blocked: orphaned Job ${orphanName} is running a different task`,
              errorCode: "k8s_concurrent_run_blocked",
            };
          } else if (classification === "block_session_mismatch") {
            await onLog("stderr", `[paperclip] Blocked: orphaned Job ${orphanName} has a different session\n`);
            return {
              exitCode: null,
              signal: null,
              timedOut: false,
              errorMessage: `Concurrent run blocked: orphaned Job ${orphanName} has a mismatched session`,
              errorCode: "k8s_orphan_session_mismatch",
            };
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

  // Prepare the prompt bundle (skills + instructions) on the server filesystem.
  // The K8s Job pod mounts the same PVC at /paperclip, so bundle paths written
  // here are accessible inside the pod at the identical absolute path.
  const skillEntries = await readPaperclipRuntimeSkillEntries(config, import.meta.dirname ?? __dirname);
  const desiredSkillNames = new Set(resolvePaperclipDesiredSkillNames(config, skillEntries));
  const desiredSkills = skillEntries.filter((e) => desiredSkillNames.has(e.key));
  const skillSummary = desiredSkills.length > 0 ? desiredSkills.map((s) => s.runtimeName ?? s.key).join(", ") : "none";
  await onLog("stdout", `[paperclip] Skills bundled (${desiredSkills.length}): ${skillSummary}\n`);
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsFileDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";
  let instructionsContents: string | null = null;
  if (instructionsFilePath) {
    try {
      const raw = await fs.readFile(instructionsFilePath, "utf-8");
      const pathDirective =
        `\nThe above agent instructions were loaded from ${instructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsFileDir}. ` +
        `This base directory is authoritative for sibling instruction files such as ` +
        `./HEARTBEAT.md, ./SOUL.md, and ./TOOLS.md; do not resolve those from the parent agent directory.`;
      instructionsContents = raw + pathDirective;
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
  const promptBundle = await prepareClaudePromptBundle({
    companyId: ctx.agent.companyId,
    skills: desiredSkills,
    instructionsContents,
    onLog,
  });

  if (reattachTarget) {
    jobName = reattachTarget.jobName;
    namespace = reattachTarget.namespace;

    // Announce reattach metadata.  Prompt and args aren't known here — they
    // belong to the prior run that created this pod and are already present
    // on the running container.
    if (onMeta) {
      await onMeta({
        adapterType: "claude_k8s",
        command: `kubectl job/${jobName}`,
        cwd: namespace,
        commandArgs: [],
        commandNotes: [
          `Image: ${reattachTarget.image}`,
          `Namespace: ${namespace}`,
          `Reattached from prior run: ${reattachTarget.priorRunId || "unknown"}`,
          `Timeout: ${timeoutSec}s`,
        ],
        prompt: "",
        context: ctx.context,
      } as Parameters<typeof onMeta>[0]);
    }

    await onLog("stdout", `[paperclip] Reattaching to in-flight K8s Job ${jobName} in namespace ${namespace} (prior run ${reattachTarget.priorRunId || "unknown"})\n`);

    // Relabel the reattached Job with the current run-id (and session-id if
    // available) so the next concurrency guard sees it as owned by this run
    // rather than an orphan from the prior run.
    const labelPatch: Array<{ op: "add" | "replace"; path: string; value: string }> = [
      { op: "replace", path: "/metadata/labels/paperclip.io~1run-id", value: runId },
    ];
    if (currentSessionLabel) {
      labelPatch.push({ op: "replace", path: "/metadata/labels/paperclip.io~1session-id", value: currentSessionLabel });
    }
    try {
      await batchApi.patchNamespacedJob({
        name: jobName,
        namespace,
        body: labelPatch,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await onLog("stderr", `[paperclip] Warning: failed to relabel reattached Job ${jobName}: ${msg}\n`);
    }
  } else {
    // Build Job manifest
    const built = buildJobManifest({ ctx, selfPod, promptBundle });
    const job = built.job;
    jobName = built.jobName;
    namespace = built.namespace;
    const prompt = built.prompt;
    const claudeArgs = built.claudeArgs;
    const promptMetrics = built.promptMetrics;
    promptSecret = built.promptSecret;
    if (built.skippedLabels.length > 0) {
      await onLog("stderr", `[paperclip] Warning: skipped ${built.skippedLabels.length} extra label(s) with reserved prefix: ${built.skippedLabels.join(", ")}\n`);
    }

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
          `Skills (${desiredSkills.length}): ${skillSummary}`,
        ],
        prompt,
        ...(promptMetrics ? { promptMetrics } : {}),
        context: ctx.context,
      } as Parameters<typeof onMeta>[0]);
    }

    // If the prompt is large, create a Secret to hold it (avoids the ~1 MiB
    // PodSpec limit).  The Secret is cleaned up in the finally block.
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
    let createdJobUid: string | undefined;
    try {
      const created = await batchApi.createNamespacedJob({ namespace, body: job });
      createdJobUid = created.metadata?.uid;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await onLog("stderr", `[paperclip] Failed to create K8s Job: ${msg}\n`);
      if (promptSecret) {
        try {
          await coreApi.deleteNamespacedSecret({ name: promptSecret.name, namespace: promptSecret.namespace });
        } catch { /* best-effort */ }
      }
      return {
        exitCode: null,
        signal: null,
        timedOut: false,
        errorMessage: `Failed to create Kubernetes Job: ${msg}`,
        errorCode: "k8s_job_create_failed",
      };
    }

    // Attach ownerReference so K8s GC cleans up the Secret if the process
    // crashes before the finally block runs.
    if (promptSecret && createdJobUid) {
      try {
        await coreApi.patchNamespacedSecret({
          name: promptSecret.name,
          namespace: promptSecret.namespace,
          body: [
            {
              op: "add",
              path: "/metadata/ownerReferences",
              value: [
                {
                  apiVersion: "batch/v1",
                  kind: "Job",
                  name: jobName,
                  uid: createdJobUid,
                  blockOwnerDeletion: false,
                },
              ],
            },
          ],
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await onLog("stderr", `[paperclip] Warning: failed to set ownerReference on prompt Secret: ${msg}\n`);
      }
    }

    await onLog("stdout", `[paperclip] Created K8s Job: ${jobName} in namespace ${namespace} (deadline: ${timeoutSec > 0 ? `${timeoutSec}s` : "none"})\n`);
  }
  } finally {
    // Release the per-agent creation mutex so the next queued execute() call
    // can proceed with its guard+create phase (FAR-29).
    _releaseMutex();
  }

  let stdout = "";
  let exitCode: number | null = null;
  let podTerminatedState: PodTerminatedState | null = null;
  let jobTimedOut = false;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  // Set when we return a mismatch error so the finally block knows not to
  // delete a job that is still alive and the UI is waiting on.
  let skipCleanup = false;
  // Set when the job disappeared (404) or grace-timer fired before we saw a
  // terminal condition — used to emit a clearer error when stdout parsing fails.
  let jobDeletedExternally = false;

  const activeJobRef: ActiveJobRef = {
    namespace,
    jobName,
    ...(promptSecret ? { promptSecretName: promptSecret.name, promptSecretNamespace: promptSecret.namespace } : {}),
    kubeconfigPath,
  };
  activeJobs.add(activeJobRef);
  ensureSigtermHandler();

  try {
    // Wait for pod to be ready for log streaming
    const scheduleTimeoutMs = 120_000; // 2 minutes for scheduling
    let podName: string;
    try {
      if (reattachTarget) {
        // Pod is already running from the prior run — look it up directly.
        const podList = await coreApi.listNamespacedPod({
          namespace,
          labelSelector: `job-name=${jobName}`,
        });
        const pod = podList.items[0];
        const name = pod?.metadata?.name;
        if (!name) {
          throw new Error(`Reattach target Job ${jobName} has no pod`);
        }
        podName = name;
        await onLog("stdout", `[paperclip] Reattached to pod ${podName}\n`);
      } else {
        podName = await waitForPod(namespace, jobName, scheduleTimeoutMs, onLog, kubeconfigPath);
        await onLog("stdout", `[paperclip] Pod running: ${podName}\n`);
      }

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const phase = reattachTarget ? "reattach" : "scheduling";
      await onLog("stderr", `[paperclip] Pod ${phase} failed: ${msg}\n`);
      return {
        exitCode: null,
        signal: null,
        timedOut: false,
        errorMessage: `Pod ${phase} failed: ${msg}`,
        errorCode: reattachTarget ? "k8s_pod_reattach_failed" : "k8s_pod_schedule_failed",
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
    let lastLogAt = Date.now();
    let keepaliveJobTerminal = false;
    let consecutiveTerminalReadings = 0;
    // Shared signal: when job completion resolves, tell the log streamer to
    // stop reconnecting.  Declared before keepaliveTimer so the cancel path
    // inside the timer can set it without temporal dead zone issues.
    const logStopSignal = { stopped: false };
    // Shared dedup filter: created here so the one-shot fallback can
    // reuse it and avoid pushing already-sent lines to the UI (finding #6, FAR-15).
    const logDedup = new LogLineDedupFilter();
    // Set when the run is externally cancelled (cancel-poll path).
    let cancelled = false;

    keepaliveTimer = setInterval(() => {
      // Fire-and-forget the async work; setInterval callbacks must be
      // synchronous or the timer will drift.
      void (async () => {
        if (keepaliveJobTerminal || cancelled) return;

        // Verify the Job is still alive before announcing or refreshing.
        // Require two consecutive terminal readings before latching to
        // guard against a stale K8s API cache returning a false terminal
        // status on a single read (finding #5, FAR-15).
        try {
          const job = await batchApi.readNamespacedJob({ name: jobName, namespace });
          const terminal = job.status?.conditions?.some(
            (c) => (c.type === "Complete" || c.type === "Failed") && c.status === "True",
          );
          if (terminal) {
            consecutiveTerminalReadings++;
            if (consecutiveTerminalReadings >= 2) {
              keepaliveJobTerminal = true;
            }
            return;
          }
          consecutiveTerminalReadings = 0;
        } catch (err: unknown) {
          // Only treat 404 (Job deleted) as terminal.  Transient 5xx or
          // connection resets should NOT permanently disable the keepalive —
          // the next tick will re-check and the reaper uses the staleness
          // window as a safety net.
          if (isK8s404(err)) {
            keepaliveJobTerminal = true;
            return;
          }
          // Log transient errors but leave keepaliveJobTerminal false so
          // the next tick retries.
          const msg = err instanceof Error ? err.message : String(err);
          void onLog("stderr", `[paperclip] keepalive: transient error checking job status: ${msg}\n`).catch(() => {});
          return;
        }

        // Cancel-polling: check if the Paperclip run was cancelled externally.
        // Skipped on the reattach path to avoid tearing down an adopted Job.
        // HTTP non-2xx is treated as transient — never interpret a 5xx as cancel.
        if (!reattachTarget && paperclipApiUrl && ctx.authToken) {
          try {
            const resp = await fetch(`${paperclipApiUrl}/api/heartbeat-runs/${runId}`, {
              headers: { Authorization: `Bearer ${ctx.authToken}` },
            });
            if (resp.ok) {
              const data = await resp.json() as { status?: string };
              if (shouldAbortForCancellation(data.status)) {
                void onLog("stdout", `[paperclip] Run cancelled externally — deleting Job ${jobName}\n`).catch(() => {});
                cancelled = true;
                logStopSignal.stopped = true;
                try {
                  await batchApi.deleteNamespacedJob({
                    name: jobName,
                    namespace,
                    body: { propagationPolicy: "Background" },
                  });
                } catch { /* best-effort — completion watcher will see 404 and settle */ }
                return;
              }
            } else if (resp.status >= 500) {
              void onLog("stderr", `[paperclip] keepalive: cancel poll returned HTTP ${resp.status} — transient, ignoring\n`).catch(() => {});
            }
          } catch {
            // network error — transient, skip this tick
          }
        }

        const silenceSec = Math.round((Date.now() - lastLogAt) / 1000);
        void onLog("stdout", `[paperclip] keepalive — job ${jobName} running (${silenceSec}s since last output)\n`).catch(() => {});
      })();
    }, KEEPALIVE_INTERVAL_MS);
    const wrappedOnLog: typeof onLog = async (stream, chunk) => {
      lastLogAt = Date.now();
      return onLog(stream, chunk);
    };

    // Track when the log stream first exits so the grace-period can fire
    // if the K8s Job condition lags behind container exit (FAR-23).
    // Set via onFirstStreamExit callback (called after attempt=0 returns)
    // rather than in .then() of streamPodLogs, which would create a
    // deadlock: streamPodLogs only resolves after stopSignal is set, but
    // stopSignal is set by the grace timer which needs logExitTime to be
    // non-null.
    let logExitTime: number | null = null;
    const trackedLogStream = streamPodLogs(
      namespace, podName, wrappedOnLog, kubeconfigPath, logStopSignal, logDedup,
      () => { logExitTime = Date.now(); },
    );

    // completionWithGrace races waitForJobCompletion against a grace timer
    // that fires LOG_EXIT_COMPLETION_GRACE_MS after the log stream exits.
    // This bounds the stale-UI window when K8s Job conditions lag container
    // exit (FAR-23): without it, waitForJobCompletion polls indefinitely
    // while streamPodLogs reconnects, holding execute() open for minutes.
    // logStopSignal.stopped is set on every settled path (fulfilled, rejected,
    // or grace) so streamPodLogs stops reconnecting promptly.
    type CompletionResult = { succeeded: boolean; timedOut: boolean; jobGone?: boolean };
    let gracePoller: ReturnType<typeof setInterval> | null = null;
    const completionWithGrace = new Promise<CompletionResult>((resolve, reject) => {
      let settled = false;
      const settleOk = (r: CompletionResult) => {
        if (settled) return;
        settled = true;
        if (gracePoller) { clearInterval(gracePoller); gracePoller = null; }
        logStopSignal.stopped = true;
        resolve(r);
      };
      const settleErr = (err: unknown) => {
        if (settled) return;
        settled = true;
        if (gracePoller) { clearInterval(gracePoller); gracePoller = null; }
        logStopSignal.stopped = true;
        reject(err);
      };
      waitForJobCompletion(namespace, jobName, completionTimeoutMs, kubeconfigPath).then(settleOk).catch(settleErr);
      gracePoller = setInterval(() => {
        if (logExitTime !== null && Date.now() - logExitTime >= LOG_EXIT_COMPLETION_GRACE_MS) {
          void onLog("stdout", `[paperclip] Log stream exited ${LOG_EXIT_COMPLETION_GRACE_MS / 1000}s ago without K8s Job condition update — proceeding with captured output (FAR-23)\n`).catch(() => {});
          settleOk({ succeeded: false, timedOut: false, jobGone: true });
        }
      }, 1_000);
    });

    const [logResult, completionResult] = await Promise.allSettled([
      trackedLogStream,
      completionWithGrace,
    ]);

    // Stop the keepalive immediately once the job has reached a terminal
    // state — do not wait for the finally block.
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }

    // If the run was externally cancelled, return a clean cancelled result
    // without processing stdout (the finally block still runs for cleanup).
    if (cancelled) {
      return {
        exitCode: null,
        signal: null,
        timedOut: false,
        errorCode: "cancelled",
        errorMessage: "Run cancelled",
      };
    }

    if (logResult.status === "fulfilled") {
      stdout = logResult.value;
    }

    // One-shot log fallback: handles two failure modes with a single read.
    // Mode 1 — empty stream: the follow stream returned nothing (fast exit before connection).
    // Mode 2 — partial stream: we have some output but no result event (follow stream raced
    //   with container exit and captured only the init line before the connection dropped).
    // A one-shot readPodLogs is more reliable for already-terminated containers and reads
    // from the beginning of the log, giving us the full output.
    // We use a cheap string scan for the result-event guard (avoids a full JSON parse here;
    // the authoritative parse happens once below after all fallbacks complete).
    const hasResultEvent = stdout.split("\n").some((l) => { try { return JSON.parse(l).type === "result"; } catch { return false; } });
    const needsOneShot = !stdout.trim() || (stdout.trim() && !hasResultEvent);
    if (needsOneShot) {
      if (!stdout.trim()) {
        await onLog("stdout", `[paperclip] Log stream returned empty — reading pod logs directly...\n`);
      }
      const oneShotLogs = await readPodLogs(namespace, podName, kubeconfigPath);
      if (!stdout.trim() && oneShotLogs.trim()) {
        stdout = oneShotLogs;
        const deduped = logDedup.filter(stdout) + logDedup.flush();
        if (deduped) await onLog("stdout", deduped);
      } else if (oneShotLogs && oneShotLogs.length > stdout.length) {
        await onLog("stdout", `[paperclip] Log stream captured partial output — supplemental one-shot read returned more content.\n`);
        const deduped = logDedup.filter(oneShotLogs) + logDedup.flush();
        if (deduped) await onLog("stdout", deduped);
        stdout = oneShotLogs;
      }
    }

    if (completionResult.status === "fulfilled") {
      jobTimedOut = completionResult.value.timedOut;
      if (completionResult.value.jobGone) {
        // Job was deleted by TTL or externally before we observed the Complete/Failed
        // condition.  The container must have exited first (TTL only fires after
        // completion), so log streaming has captured the full output — continue
        // to stdout parsing rather than returning an error.
        jobDeletedExternally = true;
        await onLog("stdout", `[paperclip] Job ${jobName} was deleted before terminal condition was observed (TTL or external deletion) — proceeding with captured output.\n`);
      }
    } else {
      // waitForJobCompletion threw an unexpected error — re-check job state to
      // avoid returning while the job is still running.  Use a bounded timeout
      // (60s) so we don't hang the heartbeat indefinitely if the K8s API is degraded.
      jobTimedOut = false;
      const RECHECK_TIMEOUT_MS = 60_000;
      const actualState = await waitForJobCompletion(namespace, jobName, RECHECK_TIMEOUT_MS, kubeconfigPath);
      if (actualState.timedOut) {
        // Re-check itself timed out — the job may still be running.
        // Return an error so the UI knows the run is not done.
        jobTimedOut = true;
      } else if (actualState.jobGone) {
        // Job was deleted before we could confirm terminal state — same as the
        // fulfilled+jobGone case above: proceed with captured output.
        jobDeletedExternally = true;
        await onLog("stdout", `[paperclip] Job ${jobName} was deleted before terminal condition was observed (TTL or external deletion) — proceeding with captured output.\n`);
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

    podTerminatedState = await getPodTerminatedState(namespace, jobName, kubeconfigPath);
    exitCode = podTerminatedState?.exitCode ?? null;
  } finally {
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    activeJobs.delete(activeJobRef);
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
    if (jobDeletedExternally && exitCode === null) {
      return {
        exitCode,
        signal: null,
        timedOut: false,
        errorMessage: "K8s Job was deleted externally before Claude could complete",
        errorCode: "k8s_job_deleted_externally",
        resultJson: { stdout },
      };
    }
    if (parsedStream.llmApiEmptyResponse) {
      return {
        exitCode,
        signal: null,
        timedOut: false,
        errorMessage: "LLM API returned an empty response (stop_reason: null, output_tokens: 0) — the upstream model API may be degraded or misconfigured",
        errorCode: "llm_api_error",
        resultJson: { stdout },
      };
    }
    if (parsedStream.truncatedMidStream) {
      const cause = describeTruncationCause(podTerminatedState);
      const modelHint = parsedStream.model ? ` (model: ${parsedStream.model})` : "";
      return {
        exitCode,
        signal: null,
        timedOut: false,
        errorMessage: `Claude run was truncated mid-stream${modelHint} — assistant produced content but no result event arrived; ${cause}`,
        errorCode: "claude_truncated",
        resultJson: { stdout },
      };
    }
    return {
      exitCode,
      signal: null,
      timedOut: false,
      errorMessage: buildPartialRunError(exitCode, parsedStream.model, stdout),
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

  const fallbackSessionId = currentSessionIdRaw;
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
