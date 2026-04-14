import { asString, asNumber, asBoolean, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { parseClaudeStreamJson, describeClaudeFailure, isClaudeMaxTurnsResult, isClaudeUnknownSessionError, } from "./parse.js";
import { getSelfPodInfo, getBatchApi, getCoreApi, getLogApi } from "./k8s-client.js";
import { buildJobManifest } from "./job-manifest.js";
import { Writable } from "node:stream";
const POLL_INTERVAL_MS = 2000;
const KEEPALIVE_INTERVAL_MS = 15_000;
const LOG_STREAM_RECONNECT_DELAY_MS = 3_000;
/**
 * Wait for the Job's pod to reach a terminal or running state.
 * Returns the pod name once logs can be streamed, or throws on failure.
 */
async function waitForPod(namespace, jobName, timeoutMs, onLog, kubeconfigPath) {
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
            const details = [`phase=${phase}`];
            for (const init of initStatuses) {
                if (init.state?.waiting)
                    details.push(`init/${init.name}: waiting (${init.state.waiting.reason ?? "unknown"})`);
                else if (init.state?.running)
                    details.push(`init/${init.name}: running`);
                else if (init.state?.terminated)
                    details.push(`init/${init.name}: done (exit ${init.state.terminated.exitCode})`);
            }
            for (const cs of containerStatuses) {
                if (cs.state?.waiting)
                    details.push(`${cs.name}: waiting (${cs.state.waiting.reason ?? "unknown"})`);
                else if (cs.state?.running)
                    details.push(`${cs.name}: running`);
            }
            await onLog("stdout", `[paperclip] Pod ${podName}: ${details.join(", ")}\n`);
            lastStatus = statusKey;
        }
        // Ready to stream logs
        if (phase === "Running" || phase === "Succeeded" || phase === "Failed") {
            return podName;
        }
        // Init containers done + main running (phase may still say Pending briefly)
        const allInitsDone = initStatuses.length > 0 && initStatuses.every((s) => s.state?.terminated?.exitCode === 0);
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
        const unschedulable = conditions.find((c) => c.type === "PodScheduled" && c.status === "False" && c.reason === "Unschedulable");
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
async function streamPodLogsOnce(namespace, podName, onLog, kubeconfigPath, sinceSeconds) {
    const logApi = getLogApi(kubeconfigPath);
    const chunks = [];
    const writable = new Writable({
        write(chunk, _encoding, callback) {
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
    }
    catch {
        // follow may fail if the container already exited or the API
        // connection dropped — not fatal, caller decides whether to retry.
    }
    return chunks.join("");
}
/**
 * Stream pod logs with automatic reconnection. Keeps retrying the log
 * stream until the stop signal fires (job completed) or the container
 * exits normally. This handles silent K8s API connection drops that
 * would otherwise cause the UI to stop receiving real output.
 */
async function streamPodLogs(namespace, podName, onLog, kubeconfigPath, stopSignal) {
    const allChunks = [];
    let attempt = 0;
    const streamStartedAt = Math.floor(Date.now() / 1000);
    while (!stopSignal?.stopped) {
        // On reconnect, ask for logs since the stream originally started to
        // avoid missing output during the reconnect gap.  Duplicates are
        // tolerable — the UI deduplicates log chunks.
        const sinceSeconds = attempt > 0
            ? Math.max(1, Math.floor(Date.now() / 1000) - streamStartedAt + 5)
            : undefined;
        if (attempt > 0) {
            await onLog("stdout", `[paperclip] Log stream disconnected — reconnecting (attempt ${attempt})...\n`);
        }
        const result = await streamPodLogsOnce(namespace, podName, onLog, kubeconfigPath, sinceSeconds);
        if (result)
            allChunks.push(result);
        attempt++;
        // If the job is done or the container exited, no need to reconnect.
        if (stopSignal?.stopped)
            break;
        // Brief pause before reconnecting to avoid tight loops.
        await new Promise((resolve) => setTimeout(resolve, LOG_STREAM_RECONNECT_DELAY_MS));
    }
    return allChunks.join("");
}
/**
 * One-shot read of pod logs (no follow). Used as fallback when the
 * follow stream missed output because the container exited quickly.
 */
async function readPodLogs(namespace, podName, kubeconfigPath) {
    const coreApi = getCoreApi(kubeconfigPath);
    try {
        const log = await coreApi.readNamespacedPodLog({
            name: podName,
            namespace,
            container: "claude",
        });
        return typeof log === "string" ? log : "";
    }
    catch {
        return "";
    }
}
/**
 * Wait for the Job to reach a terminal state (Complete or Failed).
 * Returns the Job's final status.
 */
async function waitForJobCompletion(namespace, jobName, timeoutMs, kubeconfigPath) {
    const batchApi = getBatchApi(kubeconfigPath);
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : 0;
    while (deadline === 0 || Date.now() < deadline) {
        const job = await batchApi.readNamespacedJob({ name: jobName, namespace });
        const conditions = job.status?.conditions ?? [];
        const complete = conditions.find((c) => c.type === "Complete" && c.status === "True");
        if (complete)
            return { succeeded: true, timedOut: false };
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
async function getPodExitCode(namespace, jobName, kubeconfigPath) {
    const coreApi = getCoreApi(kubeconfigPath);
    const podList = await coreApi.listNamespacedPod({
        namespace,
        labelSelector: `job-name=${jobName}`,
    });
    const pod = podList.items[0];
    if (!pod)
        return null;
    const containerStatus = pod.status?.containerStatuses?.find((s) => s.name === "claude");
    return containerStatus?.state?.terminated?.exitCode ?? null;
}
/**
 * Delete Job and its pods. Best-effort — failures are logged but not thrown.
 */
async function cleanupJob(namespace, jobName, onLog, kubeconfigPath) {
    try {
        const batchApi = getBatchApi(kubeconfigPath);
        await batchApi.deleteNamespacedJob({
            name: jobName,
            namespace,
            body: { propagationPolicy: "Background" },
        });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await onLog("stderr", `[paperclip] Warning: failed to cleanup job ${jobName}: ${msg}\n`);
    }
}
export async function execute(ctx) {
    const { runId, runtime, config: rawConfig, onLog, onMeta } = ctx;
    const config = parseObject(rawConfig);
    const timeoutSec = asNumber(config.timeoutSec, 0);
    const graceSec = asNumber(config.graceSec, 60);
    const retainJobs = asBoolean(config.retainJobs, false);
    const kubeconfigPath = asString(config.kubeconfig, "") || undefined;
    // Guard: claude_k8s must not run concurrently for the same agent (shared PVC/session)
    const agentId = ctx.agent.id;
    const selfPod = await getSelfPodInfo(kubeconfigPath);
    const guardNamespace = asString(config.namespace, "") || selfPod.namespace;
    try {
        const batchApi = getBatchApi(kubeconfigPath);
        const existing = await batchApi.listNamespacedJob({
            namespace: guardNamespace,
            labelSelector: `paperclip.io/agent-id=${agentId},paperclip.io/adapter-type=claude_k8s`,
        });
        const running = existing.items.filter((j) => !j.status?.conditions?.some((c) => (c.type === "Complete" || c.type === "Failed") && c.status === "True"));
        if (running.length > 0) {
            const names = running.map((j) => j.metadata?.name).join(", ");
            await onLog("stderr", `[paperclip] Concurrent run blocked: existing Job(s) still running for this agent: ${names}\n`);
            return {
                exitCode: null,
                signal: null,
                timedOut: false,
                errorMessage: `Concurrent run blocked: Job ${names} is still running for this agent`,
                errorCode: "k8s_concurrent_run_blocked",
            };
        }
    }
    catch {
        // If we can't check, proceed — the heartbeat service enforces concurrency too
    }
    // Build Job manifest
    const { job, jobName, namespace, prompt, claudeArgs, promptMetrics } = buildJobManifest({
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
        });
    }
    // Create the Job
    const batchApi = getBatchApi(kubeconfigPath);
    try {
        await batchApi.createNamespacedJob({ namespace, body: job });
    }
    catch (err) {
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
    let exitCode = null;
    let jobTimedOut = false;
    let keepaliveTimer = null;
    try {
        // Wait for pod to be ready for log streaming
        const scheduleTimeoutMs = 120_000; // 2 minutes for scheduling
        let podName;
        try {
            podName = await waitForPod(namespace, jobName, scheduleTimeoutMs, onLog, kubeconfigPath);
            await onLog("stdout", `[paperclip] Pod running: ${podName}\n`);
        }
        catch (err) {
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
        let lastLogAt = Date.now();
        keepaliveTimer = setInterval(() => {
            const silenceSec = Math.round((Date.now() - lastLogAt) / 1000);
            void onLog("stdout", `[paperclip] keepalive — job ${jobName} running (${silenceSec}s since last output)\n`);
        }, KEEPALIVE_INTERVAL_MS);
        const wrappedOnLog = async (stream, chunk) => {
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
        }
        else {
            jobTimedOut = true;
        }
        exitCode = await getPodExitCode(namespace, jobName, kubeconfigPath);
    }
    finally {
        if (keepaliveTimer)
            clearInterval(keepaliveTimer);
        if (!retainJobs) {
            await cleanupJob(namespace, jobName, onLog, kubeconfigPath);
        }
        else {
            await onLog("stdout", `[paperclip] Retaining job ${jobName} for debugging (retainJobs=true)\n`);
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
        const usageObj = parseObject(parsed.usage);
        return {
            inputTokens: asNumber(usageObj.input_tokens, 0),
            cachedInputTokens: asNumber(usageObj.cache_read_input_tokens, 0),
            outputTokens: asNumber(usageObj.output_tokens, 0),
        };
    })();
    const runtimeSessionParams = parseObject(runtime.sessionParams);
    const fallbackSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
    const resolvedSessionId = parsedStream.sessionId
        ?? (asString(parsed.session_id, fallbackSessionId) || fallbackSessionId);
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
        }
        : null;
    const clearSessionForMaxTurns = isClaudeMaxTurnsResult(parsed);
    return {
        exitCode,
        signal: null,
        timedOut: false,
        errorMessage: (exitCode ?? 0) === 0
            ? null
            : describeClaudeFailure(parsed) ?? `Claude exited with code ${exitCode ?? -1}`,
        usage,
        sessionId: resolvedSessionId || null,
        sessionParams: resolvedSessionParams,
        sessionDisplayId: resolvedSessionId || null,
        provider: "anthropic",
        model: parsedStream.model || asString(parsed.model, model),
        billingType: "api",
        costUsd: parsedStream.costUsd ?? asNumber(parsed.total_cost_usd, 0),
        resultJson: parsed,
        summary: parsedStream.summary || asString(parsed.result, ""),
        clearSession: clearSessionForMaxTurns,
    };
}
//# sourceMappingURL=execute.js.map