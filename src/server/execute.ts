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
// How long to keep refreshing onSpawn after the Job reaches a terminal state.
// Covers the cleanup path (delete job, parse stdout) so a slow K8s API call
// doesn't trip the 5-minute reaper staleness window.
const POST_TERMINAL_KEEPALIVE_MS = 90_000;
// Upper bound on how long streamPodLogsOnce will wait after stopSignal fires
// before force-returning, even if logApi.log has not yet resolved.  Defensive
// against the K8s client library not propagating writable.destroy() into an
// abort of the underlying HTTP request.
const LOG_STREAM_BAIL_TIMEOUT_MS = 3_000;

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

  // Walk stdout lines, skip system events, return the first real content line.
  const firstContentLine = stdout.split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => {
      if (!l) return false;
      try {
        const obj = JSON.parse(l);
        if (typeof obj === "object" && obj !== null && (obj as Record<string, unknown>).type === "system") return false;
      } catch {
        // not JSON — treat as content
      }
      return true;
    }) ?? "";

  // If we only have system/init events and nothing else, surface the model
  // name so the operator can diagnose missing credentials or unsupported model.
  const initOnlyOutput = stdout.trim() !== "" && model !== "" && !firstContentLine;
  if (initOnlyOutput) {
    const modelHint = model ? ` (model: ${model})` : "";
    return `Claude started but did not produce a result${modelHint} — check API credentials, model support, and adapter config`;
  }

  return firstContentLine
    ? `Claude exited with code ${exitCode ?? -1}: ${firstContentLine}`
    : `Claude exited with code ${exitCode ?? -1}`;
}

/**
 * Evaluate an orphaned K8s Job (one whose `paperclip.io/run-id` label does
 * not match the current runId) as a potential reattach target.  A Job is
 * reattachable when it belongs to the same agent, same task, and same resume
 * session as the current run — meaning the previous Paperclip instance was
 * mid-stream on the exact piece of work this new run was dispatched to do.
 * Exported for unit tests.
 */
export function isReattachableOrphan(
  job: k8s.V1Job,
  expected: { agentId: string; taskId: string | null; sessionId: string | null },
): boolean {
  if (!expected.taskId || !expected.sessionId) return false;
  const labels = job.metadata?.labels ?? {};
  if (labels["paperclip.io/adapter-type"] !== "claude_k8s") return false;
  if (labels["paperclip.io/agent-id"] !== expected.agentId) return false;
  if (labels["paperclip.io/task-id"] !== expected.taskId) return false;
  if (labels["paperclip.io/session-id"] !== expected.sessionId) return false;
  const conditions = job.status?.conditions ?? [];
  const terminal = conditions.some(
    (c) => (c.type === "Complete" || c.type === "Failed") && c.status === "True",
  );
  if (terminal) return false;
  return true;
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
          bailTimer = setTimeout(bailResolve, LOG_STREAM_BAIL_TIMEOUT_MS);
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
 */
async function streamPodLogs(
  namespace: string,
  podName: string,
  onLog: AdapterExecutionContext["onLog"],
  kubeconfigPath?: string,
  stopSignal?: { stopped: boolean },
): Promise<string> {
  const allChunks: string[] = [];
  let attempt = 0;
  // Track the timestamp of the last successfully received log line so
  // reconnects use a tight window instead of an ever-growing one anchored
  // at stream start.  This is the primary fix for FAR-105 duplicative logs.
  let lastLogReceivedAt = Math.floor(Date.now() / 1000);
  // Shared across reconnects so replayed lines inside the `sinceSeconds`
  // overlap window are dropped before they reach the streaming UI (FAR-123).
  const dedup = new LogLineDedupFilter();

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
  // the current runId.  When reattachOrphanedJobs is enabled and the orphan matches
  // the current agent+task+session, we attach to it instead of deleting it (FAR-124).
  const agentId = ctx.agent.id;
  const selfPod = await getSelfPodInfo(kubeconfigPath);
  const guardNamespace = asString(config.namespace, "") || selfPod.namespace;
  const reattachOrphanedJobs = asBoolean(config.reattachOrphanedJobs, true);
  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const currentSessionIdRaw = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const currentSessionLabel = currentSessionIdRaw ? sanitizeLabelValue(currentSessionIdRaw) : null;
  const currentTaskIdRaw = asString(ctx.context.taskId, "") || asString(ctx.context.issueId, "");
  const currentTaskLabel = currentTaskIdRaw ? sanitizeLabelValue(currentTaskIdRaw) : null;
  let reattachTarget: { jobName: string; namespace: string; priorRunId: string; image: string } | null = null;
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

      // Pick the most recent reattachable orphan — same agent + task + session,
      // not terminal.  Only one target is chosen; any other orphans get
      // cleaned up as before.
      if (reattachOrphanedJobs && orphaned.length > 0) {
        const candidates = orphaned
          .filter((j) =>
            isReattachableOrphan(j, {
              agentId,
              taskId: currentTaskLabel,
              sessionId: currentSessionLabel,
            }),
          )
          .sort((a, b) => {
            const at = new Date(a.metadata?.creationTimestamp ?? 0).getTime();
            const bt = new Date(b.metadata?.creationTimestamp ?? 0).getTime();
            return bt - at;
          });
        const chosen = candidates[0];
        const chosenName = chosen?.metadata?.name;
        if (chosen && chosenName) {
          reattachTarget = {
            jobName: chosenName,
            namespace: chosen.metadata?.namespace ?? guardNamespace,
            priorRunId: chosen.metadata?.labels?.["paperclip.io/run-id"] ?? "",
            image: chosen.spec?.template?.spec?.containers?.[0]?.image ?? "unknown",
          };
        }
      }

      const toDelete = orphaned.filter(
        (j) => !reattachTarget || j.metadata?.name !== reattachTarget.jobName,
      );
      if (toDelete.length > 0) {
        const orphanNames = toDelete.map((j) => j.metadata?.name).join(", ");
        await onLog("stdout", `[paperclip] Cleaning up ${toDelete.length} orphaned K8s Job(s) from previous run(s): ${orphanNames}\n`);
        for (const j of toDelete) {
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

  const coreApi = getCoreApi(kubeconfigPath);
  const batchApi = getBatchApi(kubeconfigPath);

  let jobName: string;
  let namespace: string;
  let promptSecret: { name: string; namespace: string; data: Record<string, string> } | null = null;

  // Prepare the prompt bundle (skills + instructions) on the server filesystem.
  // The K8s Job pod mounts the same PVC at /paperclip, so bundle paths written
  // here are accessible inside the pod at the identical absolute path.
  const skillEntries = await readPaperclipRuntimeSkillEntries(config, import.meta.dirname ?? __dirname);
  const desiredSkillNames = new Set(resolvePaperclipDesiredSkillNames(config, skillEntries));
  const desiredSkills = skillEntries.filter((e) => desiredSkillNames.has(e.key));
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
  }

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

      // Notify the server that execution has started.  This sets
      // processStartedAt and refreshes updatedAt in the DB, which the
      // stale-run reaper (reapOrphanedRuns) uses to decide liveness.
      if (ctx.onSpawn) {
        await ctx.onSpawn({
          pid: process.pid,     // Paperclip server PID — always alive while adapter runs in-process
          processGroupId: null,
          startedAt: new Date().toISOString(),
        });
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
    let keepaliveJobTerminalAt: number | null = null;
    keepaliveTimer = setInterval(() => {
      // Fire-and-forget the async work; setInterval callbacks must be
      // synchronous or the timer will drift.
      void (async () => {
        if (keepaliveJobTerminal) {
          // Post-terminal window: keep refreshing onSpawn during cleanup
          // (job deletion, log parsing, K8s API calls) so the reaper doesn't
          // fire a false process_lost while execute() is still running.
          if (
            ctx.onSpawn &&
            keepaliveJobTerminalAt !== null &&
            Date.now() - keepaliveJobTerminalAt <= POST_TERMINAL_KEEPALIVE_MS
          ) {
            keepaliveTick++;
            if (keepaliveTick % 6 === 0) {
              void ctx.onSpawn({ pid: process.pid, processGroupId: null, startedAt: new Date().toISOString() }).catch(() => {});
            }
          }
          return;
        }

        // Verify the Job is still alive before announcing or refreshing.
        try {
          const job = await batchApi.readNamespacedJob({ name: jobName, namespace });
          const terminal = job.status?.conditions?.some(
            (c) => (c.type === "Complete" || c.type === "Failed") && c.status === "True",
          );
          if (terminal) {
            keepaliveJobTerminal = true;
            keepaliveJobTerminalAt = Date.now();
            if (ctx.onSpawn) {
              void ctx.onSpawn({ pid: process.pid, processGroupId: null, startedAt: new Date().toISOString() }).catch(() => {});
            }
            return;
          }
        } catch (err: unknown) {
          // Only treat 404 (Job deleted) as terminal.  Transient 5xx or
          // connection resets should NOT permanently disable the keepalive —
          // the next tick will re-check and the reaper uses the staleness
          // window as a safety net.
          if (isK8s404(err)) {
            keepaliveJobTerminal = true;
            keepaliveJobTerminalAt = Date.now();
            if (ctx.onSpawn) {
              void ctx.onSpawn({ pid: process.pid, processGroupId: null, startedAt: new Date().toISOString() }).catch(() => {});
            }
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
          void ctx.onSpawn({ pid: process.pid, processGroupId: null, startedAt: new Date().toISOString() }).catch(() => {});
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

    // One-shot log fallback: handles two failure modes with a single read.
    // Mode 1 — empty stream: the follow stream returned nothing (fast exit before connection).
    // Mode 2 — partial stream: we have some output but no result event (follow stream raced
    //   with container exit and captured only the init line before the connection dropped).
    // A one-shot readPodLogs is more reliable for already-terminated containers and reads
    // from the beginning of the log, giving us the full output.
    // We use a cheap string scan for the result-event guard (avoids a full JSON parse here;
    // the authoritative parse happens once below after all fallbacks complete).
    const hasResultEvent = stdout.includes('"type":"result"');
    const needsOneShot = !stdout.trim() || (stdout.trim() && !hasResultEvent);
    if (needsOneShot) {
      if (!stdout.trim()) {
        await onLog("stdout", `[paperclip] Log stream returned empty — reading pod logs directly...\n`);
      }
      const oneShotLogs = await readPodLogs(namespace, podName, kubeconfigPath);
      if (!stdout.trim() && oneShotLogs.trim()) {
        stdout = oneShotLogs;
        await onLog("stdout", stdout);
      } else if (oneShotLogs && oneShotLogs.length > stdout.length) {
        await onLog("stdout", `[paperclip] Log stream captured partial output — supplemental one-shot read returned more content.\n`);
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
