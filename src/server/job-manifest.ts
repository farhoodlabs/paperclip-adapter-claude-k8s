import type * as k8s from "@kubernetes/client-node";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  asBoolean,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  renderTemplate,
} from "@paperclipai/adapter-utils/server-utils";
import { createHash } from "node:crypto";

/**
 * Build the shell command prefix that installs a native Node.js PostToolUse
 * hook into Claude Code's settings.  The hook truncates oversized tool outputs
 * before they reach the model — replacing the RTK binary init-container
 * approach with a self-contained Node.js implementation.
 *
 * Both scripts are base64-encoded so they can be embedded in a sh -c command
 * string without any quoting or escaping issues.
 *
 * @param maxOutputBytes  Byte threshold above which tool output is truncated.
 * @returns               A shell command string (suitable for "&&"-chaining
 *                        before the claude invocation).
 */
export function buildRtkSetupCommands(maxOutputBytes: number): string {
  // --- Filter script ----------------------------------------------------------
  // This script runs as the PostToolUse hook inside every K8s Job pod.
  // Claude Code writes the hook event as JSON to the script's stdin; the script
  // truncates the tool_response/tool_result content when it exceeds the
  // threshold and writes the (possibly modified) JSON to stdout.
  //
  // Field-name coverage:
  //   • tool_response — documented hook event format for PostToolUse
  //   • tool_result   — alternative name seen in some Claude Code versions
  // Content may be a plain string or an array of typed blocks (text/image/…).
  const filterScript = [
    `const c=[];`,
    `process.stdin.on('data',d=>c.push(d));`,
    `process.stdin.on('end',()=>{`,
    `const raw=Buffer.concat(c).toString('utf-8');`,
    `let o;try{o=JSON.parse(raw);}catch{process.stdout.write(raw);return;}`,
    `const MAX=${maxOutputBytes};`,
    `function trunc(s){`,
    `if(typeof s!=='string')return s;`,
    `const b=Buffer.from(s,'utf-8');`,
    `if(b.length<=MAX)return s;`,
    `return b.slice(0,MAX).toString('utf-8')+'\\n[...'+(b.length-MAX)+' bytes truncated by paperclip-rtk]';`,
    `}`,
    `const tr=o&&(o.tool_response||o.tool_result);`,
    `if(tr){`,
    `if(typeof tr.content==='string'){tr.content=trunc(tr.content);}`,
    `else if(Array.isArray(tr.content)){`,
    `tr.content=tr.content.map(function(b){`,
    `if(b&&typeof b==='object'&&typeof b.text==='string'){`,
    `return Object.assign({},b,{text:trunc(b.text)});`,
    `}return b;`,
    `});`,
    `}`,
    `}`,
    `process.stdout.write(JSON.stringify(o));`,
    `});`,
  ].join("");

  // --- Settings script --------------------------------------------------------
  // Reads the existing ~/.claude/settings.json (if any), merges in the RTK
  // PostToolUse hook, and writes the file back.  All other settings sections
  // are preserved; only PostToolUse is replaced so we own the full hook list
  // for this run.
  const settingsScript = [
    `const fs=require('fs'),pt=require('path');`,
    `const p=pt.join(process.env.HOME,'.claude','settings.json');`,
    `let s={};try{s=JSON.parse(fs.readFileSync(p,'utf-8'));}catch(e){}`,
    `s.hooks=s.hooks||{};`,
    `s.hooks.PostToolUse=[{matcher:'.*',hooks:[{type:'command',command:'node /tmp/.rtk-filter.js'}]}];`,
    `fs.mkdirSync(pt.dirname(p),{recursive:true});`,
    `fs.writeFileSync(p,JSON.stringify(s));`,
  ].join("");

  // Encode as base64 so the strings can be embedded directly in a shell command
  // without any quoting concerns (base64 alphabet: A-Za-z0-9+/=).
  const filterB64 = Buffer.from(filterScript, "utf-8").toString("base64");
  const settingsB64 = Buffer.from(settingsScript, "utf-8").toString("base64");

  return [
    // Write the filter script
    `node -e "require('fs').writeFileSync('/tmp/.rtk-filter.js',Buffer.from('${filterB64}','base64').toString('utf-8'))"`,
    // Install the Claude Code PostToolUse hook (merge into existing settings)
    `node -e "eval(Buffer.from('${settingsB64}','base64').toString('utf-8'))"`,
  ].join(" && ");
}

/** Prompts above this size (bytes) are staged via a Secret instead of an
 *  init container env var, protecting against the ~1 MiB PodSpec limit. */
const LARGE_PROMPT_THRESHOLD_BYTES = 256 * 1024;

// Inline prompt assembly — these functions are not yet in the published adapter-utils
function joinPromptSections(sections: string[], separator = "\n\n"): string {
  return sections.filter((s) => s.trim().length > 0).join(separator);
}

function stringifyPaperclipWakePayload(wake: unknown): string | null {
  if (!wake || typeof wake !== "object") return null;
  try {
    const json = JSON.stringify(wake);
    return json === "{}" ? null : json;
  } catch {
    return null;
  }
}

function renderPaperclipWakePrompt(wake: unknown, _opts?: { resumedSession?: boolean }): string {
  if (!wake || typeof wake !== "object") return "";
  const w = wake as Record<string, unknown>;
  const reason = typeof w.reason === "string" ? w.reason.trim() : "";
  const comments = Array.isArray(w.comments) ? w.comments : [];
  if (!reason && comments.length === 0) return "";
  const parts: string[] = [];
  if (reason) parts.push(`Wake reason: ${reason}`);
  for (const c of comments) {
    if (typeof c === "object" && c !== null) {
      const comment = c as Record<string, unknown>;
      const body = typeof comment.body === "string" ? comment.body.trim() : "";
      if (body) parts.push(`Comment: ${body}`);
    }
  }
  return parts.join("\n\n");
}
import type { SelfPodInfo } from "./k8s-client.js";

/**
 * Parse a config value that may be either a JSON object or multiline
 * `key=value` text (one pair per line).  This fixes the config-hint
 * parity issue where textarea hints promise `key=value` per line but
 * `parseObject` only handles JSON.
 */
function parseKeyValueConfig(raw: unknown): Record<string, string> {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    // Already an object (JSON was parsed upstream)
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string") result[k] = v;
    }
    return result;
  }
  if (typeof raw !== "string" || !raw.trim()) return {};
  // Try JSON parse first
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const result: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string") result[k] = v;
      }
      return result;
    }
  } catch {
    // Not JSON — fall through to key=value parsing
  }
  // Parse key=value lines
  const result: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

export interface JobBuildInput {
  ctx: AdapterExecutionContext;
  selfPod: SelfPodInfo;
}

/** When the prompt exceeds the env-var size limit, the manifest uses a
 *  Secret-backed volume instead of the init container's PROMPT_CONTENT env.
 *  The caller must create this Secret before the Job and clean it up after. */
export interface PromptSecret {
  name: string;
  namespace: string;
  data: Record<string, string>;
}

export interface JobBuildResult {
  job: k8s.V1Job;
  jobName: string;
  namespace: string;
  prompt: string;
  claudeArgs: string[];
  promptMetrics: Record<string, number>;
  /** Non-null when the prompt is too large for an env var and must be
   *  staged as a K8s Secret before creating the Job. */
  promptSecret: PromptSecret | null;
}

function sanitizeForK8sName(value: string, maxLen = 16): string {
  return value.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, maxLen);
}

/**
 * Build a short deterministic hash suffix from the raw inputs to avoid
 * collisions when sanitized slugs happen to be identical.
 */
function shortHash(input: string, len = 6): string {
  return createHash("sha256").update(input).digest("hex").slice(0, len);
}

function buildEnvVars(
  ctx: AdapterExecutionContext,
  selfPod: SelfPodInfo,
  config: Record<string, unknown>,
): k8s.V1EnvVar[] {
  const { runId, agent, context } = ctx;
  const envConfig = parseObject(config.env);

  // Layer 1: PAPERCLIP_* base vars
  const paperclipEnv = buildPaperclipEnv(agent);

  // Layer 2: Context vars (run, wake, workspace — same as claude_local)
  paperclipEnv.PAPERCLIP_RUN_ID = runId;

  const setIfPresent = (envKey: string, value: unknown) => {
    if (typeof value === "string" && value.trim().length > 0) {
      paperclipEnv[envKey] = value.trim();
    }
  };

  setIfPresent("PAPERCLIP_TASK_ID", context.taskId ?? context.issueId);
  setIfPresent("PAPERCLIP_WAKE_REASON", context.wakeReason);
  setIfPresent("PAPERCLIP_WAKE_COMMENT_ID", context.wakeCommentId ?? context.commentId);
  setIfPresent("PAPERCLIP_APPROVAL_ID", context.approvalId);
  setIfPresent("PAPERCLIP_APPROVAL_STATUS", context.approvalStatus);

  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
  if (wakePayloadJson) {
    paperclipEnv.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
  }

  const workspaceContext = parseObject(context.paperclipWorkspace);
  setIfPresent("PAPERCLIP_WORKSPACE_CWD", workspaceContext.cwd);
  setIfPresent("PAPERCLIP_WORKSPACE_SOURCE", workspaceContext.source);
  setIfPresent("PAPERCLIP_WORKSPACE_STRATEGY", workspaceContext.strategy);
  setIfPresent("PAPERCLIP_WORKSPACE_ID", workspaceContext.workspaceId);
  setIfPresent("PAPERCLIP_WORKSPACE_REPO_URL", workspaceContext.repoUrl);
  setIfPresent("PAPERCLIP_WORKSPACE_REPO_REF", workspaceContext.repoRef);
  setIfPresent("PAPERCLIP_WORKSPACE_BRANCH", workspaceContext.branchName);
  setIfPresent("PAPERCLIP_WORKSPACE_WORKTREE_PATH", workspaceContext.worktreePath);
  setIfPresent("AGENT_HOME", workspaceContext.agentHome);

  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    : [];
  if (linkedIssueIds.length > 0) {
    paperclipEnv.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  }

  if (Array.isArray(context.paperclipWorkspaces) && context.paperclipWorkspaces.length > 0) {
    paperclipEnv.PAPERCLIP_WORKSPACES_JSON = JSON.stringify(context.paperclipWorkspaces);
  }
  if (Array.isArray(context.paperclipRuntimeServiceIntents) && context.paperclipRuntimeServiceIntents.length > 0) {
    paperclipEnv.PAPERCLIP_RUNTIME_SERVICE_INTENTS_JSON = JSON.stringify(context.paperclipRuntimeServiceIntents);
  }
  if (Array.isArray(context.paperclipRuntimeServices) && context.paperclipRuntimeServices.length > 0) {
    paperclipEnv.PAPERCLIP_RUNTIME_SERVICES_JSON = JSON.stringify(context.paperclipRuntimeServices);
  }
  setIfPresent("PAPERCLIP_RUNTIME_PRIMARY_URL", context.paperclipRuntimePrimaryUrl);

  // Auth token for agent callback to Paperclip API
  if (ctx.authToken) {
    paperclipEnv.PAPERCLIP_API_KEY = ctx.authToken;
  }

  // PAPERCLIP_API_URL is inherited from the Deployment env via selfPod.inheritedEnv.
  // buildPaperclipEnv() sets a localhost value which is wrong for Job pods —
  // the inherited value (set in the infra repo) points to the in-cluster service.
  if (selfPod.inheritedEnv.PAPERCLIP_API_URL) {
    paperclipEnv.PAPERCLIP_API_URL = selfPod.inheritedEnv.PAPERCLIP_API_URL;
  }

  // Layer 3: Inherited from Deployment (Bedrock, API keys, etc.)
  const merged: Record<string, string> = {
    ...selfPod.inheritedEnv,
    ...paperclipEnv,
  };

  // Layer 4: User-defined overrides from adapterConfig.env (wins over everything)
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") merged[key] = value;
  }

  // HOME must be /paperclip to match PVC mount and enable session resume
  merged.HOME = "/paperclip";

  // Convert literal env to V1EnvVar array
  const envVars: k8s.V1EnvVar[] = Object.entries(merged).map(([name, value]) => ({
    name,
    value,
  }));

  // Append valueFrom entries from the Deployment container (secretKeyRef,
  // configMapKeyRef, fieldRef, etc.).  Skip any whose name was already set
  // by a literal value — the literal value wins (same precedence as above).
  const literalNames = new Set(Object.keys(merged));
  for (const entry of selfPod.inheritedEnvValueFrom) {
    if (!literalNames.has(entry.name)) {
      envVars.push(entry);
    }
  }

  return envVars;
}

export function buildJobManifest(input: JobBuildInput): JobBuildResult {
  const { ctx, selfPod } = input;
  const { runId, agent, runtime, config: rawConfig, context } = ctx;
  const config = parseObject(rawConfig);

  // Resolve config values
  const namespace = asString(config.namespace, "") || selfPod.namespace;
  const image = asString(config.image, "") || selfPod.image;
  const model = asString(config.model, "");
  const effort = asString(config.effort, "");
  const maxTurns = asNumber(config.maxTurnsPerRun, 0);
  // K8s Job pods are always unattended — no one to approve permission prompts
  const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, true);
  const extraArgs = asStringArray(config.extraArgs);
  const timeoutSec = asNumber(config.timeoutSec, 0);
  const ttlSeconds = asNumber(config.ttlSecondsAfterFinished, 300);
  const resources = parseObject(config.resources);
  const nodeSelector = parseKeyValueConfig(config.nodeSelector);
  const tolerations = Array.isArray(config.tolerations) ? config.tolerations : [];
  const extraLabels = parseKeyValueConfig(config.labels);
  const enableRtk = asBoolean(config.enableRtk, false);
  const rtkMaxOutputBytes = asNumber(config.rtkMaxOutputBytes, 50000);

  // Resolve working directory — use workspace cwd, fall back to /paperclip
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const configuredCwd = asString(config.cwd, "");
  const workingDir = workspaceCwd || configuredCwd || "/paperclip";

  // Build a deterministic, collision-resistant job name within the 63-char
  // DNS label limit.  Layout: "ac-{agentSlug}-{runSlug}-{hash}" where the
  // hash is derived from the raw (un-truncated) agent+run IDs.
  const agentSlug = sanitizeForK8sName(agent.id, 16);
  const runSlug = sanitizeForK8sName(runId, 16);
  const hash = shortHash(`${agent.id}:${runId}`);
  const jobName = `ac-${agentSlug}-${runSlug}-${hash}`;

  // Build prompt (same logic as claude_local)
  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const renderedBootstrapPrompt =
    !runtimeSessionId && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: Boolean(runtimeSessionId) });
  const shouldUseResumeDeltaPrompt = Boolean(runtimeSessionId) && wakePrompt.length > 0;
  const renderedPrompt = shouldUseResumeDeltaPrompt ? "" : renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const prompt = joinPromptSections([
    renderedBootstrapPrompt,
    wakePrompt,
    sessionHandoffNote,
    renderedPrompt,
  ]);
  const promptMetrics = {
    promptChars: prompt.length,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    wakePromptChars: wakePrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  // Build Claude CLI args
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const claudeArgs = ["--print", "-", "--output-format", "stream-json", "--verbose"];
  if (runtimeSessionId) claudeArgs.push("--resume", runtimeSessionId);
  if (dangerouslySkipPermissions) claudeArgs.push("--dangerously-skip-permissions");
  if (model) claudeArgs.push("--model", model);
  if (effort) claudeArgs.push("--effort", effort);
  if (maxTurns > 0) claudeArgs.push("--max-turns", String(maxTurns));
  if (instructionsFilePath) claudeArgs.push("--append-system-prompt-file", instructionsFilePath);
  if (extraArgs.length > 0) claudeArgs.push(...extraArgs);

  // Build env vars
  const envVars = buildEnvVars(ctx, selfPod, config);

  // Resource defaults
  const resourceRequests = parseObject(resources.requests);
  const resourceLimits = parseObject(resources.limits);
  const containerResources: k8s.V1ResourceRequirements = {
    requests: {
      cpu: asString(resourceRequests.cpu, "1000m"),
      memory: asString(resourceRequests.memory, "2Gi"),
    },
    limits: {
      cpu: asString(resourceLimits.cpu, "4000m"),
      memory: asString(resourceLimits.memory, "8Gi"),
    },
  };

  // Labels
  const labels: Record<string, string> = {
    "app.kubernetes.io/managed-by": "paperclip",
    "app.kubernetes.io/component": "agent-job",
    "paperclip.io/agent-id": agent.id,
    "paperclip.io/run-id": runId,
    "paperclip.io/company-id": agent.companyId,
    "paperclip.io/adapter-type": "claude_k8s",
  };
  for (const [key, value] of Object.entries(extraLabels)) {
    labels[key] = value;
  }

  // Volumes
  const volumes: k8s.V1Volume[] = [
    {
      name: "prompt",
      emptyDir: {},
    },
  ];
  const volumeMounts: k8s.V1VolumeMount[] = [
    {
      name: "prompt",
      mountPath: "/tmp/prompt",
    },
  ];

  // Mount shared PVC for /paperclip (session state, workspaces, data)
  if (selfPod.pvcClaimName) {
    volumes.push({
      name: "data",
      persistentVolumeClaim: { claimName: selfPod.pvcClaimName },
    });
    volumeMounts.push({
      name: "data",
      mountPath: "/paperclip",
    });
  }

  // Mount secret volumes inherited from the Deployment pod
  for (const sv of selfPod.secretVolumes) {
    volumes.push({
      name: sv.volumeName,
      secret: { secretName: sv.secretName, defaultMode: sv.defaultMode, optional: true },
    });
    volumeMounts.push({
      name: sv.volumeName,
      mountPath: sv.mountPath,
      readOnly: true,
    });
  }

  // Security context matching the main Deployment
  const securityContext: k8s.V1SecurityContext = {
    capabilities: { drop: ["ALL"] },
    readOnlyRootFilesystem: false,
    runAsNonRoot: true,
    runAsUser: 1000,
    allowPrivilegeEscalation: false,
  };

  const podSecurityContext: k8s.V1PodSecurityContext = {
    runAsNonRoot: true,
    runAsUser: 1000,
    runAsGroup: 1000,
    fsGroup: 1000,
    fsGroupChangePolicy: "OnRootMismatch",
  };

  // Build the claude command string for the main container
  const claudeArgsEscaped = claudeArgs.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  const claudeInvocation = `cat /tmp/prompt/prompt.txt | claude ${claudeArgsEscaped}`;
  // When RTK output filtering is enabled, prepend the Node.js hook setup.
  // This writes a filter script and a Claude Code settings file that installs
  // it as a PostToolUse hook — no external binary or init container required.
  const mainCommand = enableRtk
    ? `${buildRtkSetupCommands(rtkMaxOutputBytes)} && ${claudeInvocation}`
    : claudeInvocation;

  // Decide prompt delivery strategy: env var (small) or Secret volume (large).
  const promptBytes = Buffer.byteLength(prompt, "utf-8");
  const useLargePromptPath = promptBytes > LARGE_PROMPT_THRESHOLD_BYTES;
  let promptSecret: PromptSecret | null = null;
  const promptSecretName = `${jobName}-prompt`;

  if (useLargePromptPath) {
    // Stage prompt as a Secret; the init container copies from the mounted
    // secret volume to the emptyDir so the main container reads it the
    // same way regardless of prompt size.
    promptSecret = {
      name: promptSecretName,
      namespace,
      data: { "prompt.txt": prompt },
    };
    volumes.push({
      name: "prompt-secret",
      secret: { secretName: promptSecretName, optional: false },
    });
  }

  const initContainer: k8s.V1Container = useLargePromptPath
    ? {
        name: "write-prompt",
        image: "busybox:1.36",
        imagePullPolicy: "IfNotPresent",
        command: ["sh", "-c", "cp /tmp/prompt-secret/prompt.txt /tmp/prompt/prompt.txt"],
        volumeMounts: [
          { name: "prompt", mountPath: "/tmp/prompt" },
          { name: "prompt-secret", mountPath: "/tmp/prompt-secret", readOnly: true },
        ],
        securityContext,
        resources: {
          requests: { cpu: "10m", memory: "16Mi" },
          limits: { cpu: "100m", memory: "64Mi" },
        },
      }
    : {
        name: "write-prompt",
        image: "busybox:1.36",
        imagePullPolicy: "IfNotPresent",
        command: ["sh", "-c", "printf '%s' \"$PROMPT_CONTENT\" > /tmp/prompt/prompt.txt"],
        env: [{ name: "PROMPT_CONTENT", value: prompt }],
        volumeMounts: [{ name: "prompt", mountPath: "/tmp/prompt" }],
        securityContext,
        resources: {
          requests: { cpu: "10m", memory: "16Mi" },
          limits: { cpu: "100m", memory: "64Mi" },
        },
      };

  const job: k8s.V1Job = {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: jobName,
      namespace,
      labels,
      annotations: {
        "paperclip.io/adapter-type": "claude_k8s",
        "paperclip.io/agent-name": agent.name,
      },
    },
    spec: {
      backoffLimit: 0,
      ...(timeoutSec > 0 ? { activeDeadlineSeconds: timeoutSec } : {}),
      ttlSecondsAfterFinished: ttlSeconds,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: "Never",
          serviceAccountName: asString(config.serviceAccountName, "") || undefined,
          securityContext: podSecurityContext,
          ...(selfPod.imagePullSecrets.length > 0 ? { imagePullSecrets: selfPod.imagePullSecrets } : {}),
          ...(selfPod.dnsConfig ? { dnsConfig: selfPod.dnsConfig } : {}),
          ...(Object.keys(nodeSelector).length > 0 ? { nodeSelector } : {}),
          ...(tolerations.length > 0 ? { tolerations: tolerations as k8s.V1Toleration[] } : {}),
          initContainers: [initContainer],
          containers: [
            {
              name: "claude",
              image,
              imagePullPolicy: asString(config.imagePullPolicy, "IfNotPresent"),
              workingDir,
              command: ["sh", "-c", mainCommand],
              env: envVars,
              ...(selfPod.inheritedEnvFrom.length > 0 ? { envFrom: selfPod.inheritedEnvFrom } : {}),
              volumeMounts,
              securityContext,
              resources: containerResources,
            },
          ],
          volumes,
        },
      },
    },
  };

  return { job, jobName, namespace, prompt, claudeArgs, promptMetrics, promptSecret };
}
