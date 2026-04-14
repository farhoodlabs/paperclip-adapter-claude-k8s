import { describe, it, expect, beforeEach } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { buildJobManifest } from "./job-manifest.js";
import type { SelfPodInfo } from "./k8s-client.js";

function makeCtx(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-abc12345",
    agent: { id: "agent-abc", companyId: "co1", name: "Test Agent", adapterType: "claude_k8s", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {},
    context: {},
    onLog: async () => {},
    ...overrides,
  };
}

function makeSelfPod(overrides: Partial<SelfPodInfo> = {}): SelfPodInfo {
  return {
    namespace: "paperclip",
    image: "paperclipai/paperclip:latest",
    imagePullSecrets: [{ name: "regcred" }],
    dnsConfig: undefined,
    pvcClaimName: "paperclip-data",
    secretVolumes: [],
    inheritedEnv: {},
    ...overrides,
  };
}

describe("buildJobManifest", () => {
  let ctx: AdapterExecutionContext;
  let selfPod: SelfPodInfo;

  beforeEach(() => {
    ctx = makeCtx();
    selfPod = makeSelfPod();
  });

  describe("job naming", () => {
    it("uses agent-claude- prefix", () => {
      const { jobName } = buildJobManifest({ ctx, selfPod });
      expect(jobName).toMatch(/^agent-claude-/);
    });

    it("includes sanitized agent id slug", () => {
      ctx.agent.id = "Agent-ABC!@#";
      const { jobName } = buildJobManifest({ ctx, selfPod });
      // sanitizeForK8sName: lowercase, strip non-alphanumeric (not dashes), slice 0-8
      // "Agent-ABC!@#" -> "agent-abc" (strips !@#, slice to 8 = "agent-ab")
      expect(jobName).toContain("agent-ab");
    });

    it("includes sanitized run id slug", () => {
      ctx.runId = "RUN-ABC-12345";
      const { jobName } = buildJobManifest({ ctx, selfPod });
      // sanitizeForK8sName: lowercase, strip non-alphanumeric (not dashes), slice 0-8
      // "RUN-ABC-12345" -> "run-abc-12345" (slice to 8 = "run-abc-")
      expect(jobName).toContain("run-abc-");
    });
  });

  describe("job spec", () => {
    it("sets backoffLimit to 0 for fail-fast", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.backoffLimit).toBe(0);
    });

    it("sets activeDeadlineSeconds when timeoutSec > 0", () => {
      ctx.config = { timeoutSec: 300 };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.activeDeadlineSeconds).toBe(300);
    });

    it("omits activeDeadlineSeconds when timeoutSec is 0", () => {
      ctx.config = { timeoutSec: 0 };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.activeDeadlineSeconds).toBeUndefined();
    });

    it("sets ttlSecondsAfterFinished default 300", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.ttlSecondsAfterFinished).toBe(300);
    });

    it("uses configured ttlSecondsAfterFinished", () => {
      ctx.config = { ttlSecondsAfterFinished: 600 };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.ttlSecondsAfterFinished).toBe(600);
    });
  });

  describe("labels", () => {
    it("includes required paperclip labels", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      const labels = job.metadata?.labels ?? {};
      expect(labels["app.kubernetes.io/managed-by"]).toBe("paperclip");
      expect(labels["app.kubernetes.io/component"]).toBe("agent-job");
      expect(labels["paperclip.io/agent-id"]).toBe("agent-abc");
      expect(labels["paperclip.io/run-id"]).toBe("run-abc12345");
      expect(labels["paperclip.io/company-id"]).toBe("co1");
      expect(labels["paperclip.io/adapter-type"]).toBe("claude_k8s");
    });

    it("includes extra labels from config", () => {
      ctx.config = { labels: { "env": "prod", "team": "platform" } };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.metadata?.labels?.env).toBe("prod");
      expect(job.metadata?.labels?.team).toBe("platform");
    });

    it("merges extra labels with required ones", () => {
      ctx.config = { labels: { "env": "prod" } };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.metadata?.labels?.env).toBe("prod");
      expect(job.metadata?.labels?.["paperclip.io/adapter-type"]).toBe("claude_k8s");
    });
  });

  describe("annotations", () => {
    it("includes adapter type and agent name annotations", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.metadata?.annotations?.["paperclip.io/adapter-type"]).toBe("claude_k8s");
      expect(job.metadata?.annotations?.["paperclip.io/agent-name"]).toBe("Test Agent");
    });
  });

  describe("pod spec", () => {
    it("sets restartPolicy to Never", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.restartPolicy).toBe("Never");
    });

    it("sets fsGroupChangePolicy to OnRootMismatch", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.securityContext?.fsGroupChangePolicy).toBe("OnRootMismatch");
    });

    it("sets fsGroup, runAsNonRoot, runAsUser, runAsGroup", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      const sc = job.spec?.template?.spec?.securityContext;
      expect(sc?.runAsNonRoot).toBe(true);
      expect(sc?.runAsUser).toBe(1000);
      expect(sc?.runAsGroup).toBe(1000);
      expect(sc?.fsGroup).toBe(1000);
    });

    it("includes imagePullSecrets from selfPod", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.imagePullSecrets).toEqual([{ name: "regcred" }]);
    });

    it("omits imagePullSecrets when empty", () => {
      selfPod.imagePullSecrets = [];
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.imagePullSecrets).toBeUndefined();
    });

    it("includes dnsConfig from selfPod when present", () => {
      selfPod.dnsConfig = { nameservers: ["8.8.8.8"], searches: ["svc.cluster.local"] };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.dnsConfig).toEqual({ nameservers: ["8.8.8.8"], searches: ["svc.cluster.local"] });
    });

    it("omits dnsConfig when not present", () => {
      selfPod.dnsConfig = undefined;
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.dnsConfig).toBeUndefined();
    });
  });

  describe("init containers", () => {
    it("has write-prompt init container with busybox image", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      const init = job.spec?.template?.spec?.initContainers?.[0];
      expect(init?.name).toBe("write-prompt");
      expect(init?.image).toBe("busybox:1.36");
      expect(init?.imagePullPolicy).toBe("IfNotPresent");
    });

    it("write-prompt writes PROMPT_CONTENT to /tmp/prompt/prompt.txt", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      const init = job.spec?.template?.spec?.initContainers?.[0];
      expect(init?.command).toEqual(["sh", "-c", "echo \"$PROMPT_CONTENT\" > /tmp/prompt/prompt.txt"]);
    });

    it("write-prompt mounts prompt volume", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      const init = job.spec?.template?.spec?.initContainers?.[0];
      expect(init?.volumeMounts).toContainEqual({ name: "prompt", mountPath: "/tmp/prompt" });
    });

    it("prompt env var contains rendered prompt text", () => {
      const { job, prompt } = buildJobManifest({ ctx, selfPod });
      const init = job.spec?.template?.spec?.initContainers?.[0];
      const promptEnv = init?.env?.find((e: { name: string }) => e.name === "PROMPT_CONTENT");
      expect(promptEnv?.value).toBe(prompt);
    });
  });

  describe("claude container", () => {
    it("names container 'claude'", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.containers[0]?.name).toBe("claude");
    });

    it("uses selfPod image by default", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.containers[0]?.image).toBe("paperclipai/paperclip:latest");
    });

    it("uses configured image override", () => {
      ctx.config = { image: "my-image:v2" };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.containers[0]?.image).toBe("my-image:v2");
    });

    it("sets imagePullPolicy from config", () => {
      ctx.config = { imagePullPolicy: "Always" };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.containers[0]?.imagePullPolicy).toBe("Always");
    });

    it("defaults imagePullPolicy to IfNotPresent", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.containers[0]?.imagePullPolicy).toBe("IfNotPresent");
    });

    it("sets workingDir to /paperclip by default", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.containers[0]?.workingDir).toBe("/paperclip");
    });

    it("uses workspace cwd when available", () => {
      ctx.context = { paperclipWorkspace: { cwd: "/workspace/myproject" } };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.containers[0]?.workingDir).toBe("/workspace/myproject");
    });

    it("prefers workspace cwd over configured cwd", () => {
      ctx.config = { cwd: "/custom/path" };
      ctx.context = { paperclipWorkspace: { cwd: "/workspace/myproject" } };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.containers[0]?.workingDir).toBe("/workspace/myproject");
    });
  });

  describe("volumes", () => {
    it("creates prompt emptyDir volume", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      const promptVol = job.spec?.template?.spec?.volumes?.find((v) => v.name === "prompt");
      expect(promptVol?.emptyDir).toEqual({});
    });

    it("mounts data PVC at /paperclip when pvcClaimName is set", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      const dataVol = job.spec?.template?.spec?.volumes?.find((v) => v.name === "data");
      expect(dataVol?.persistentVolumeClaim?.claimName).toBe("paperclip-data");
      const dataMount = job.spec?.template?.spec?.containers[0]?.volumeMounts?.find((vm) => vm.mountPath === "/paperclip");
      expect(dataMount?.name).toBe("data");
    });

    it("omits data volume when no PVC", () => {
      selfPod.pvcClaimName = null;
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.volumes?.find((v) => v.name === "data")).toBeUndefined();
    });

    it("mounts secret volumes", () => {
      selfPod.secretVolumes = [{
        volumeName: "my-secret",
        secretName: "app-secret",
        mountPath: "/secrets/app",
        defaultMode: 420,
      }];
      const { job } = buildJobManifest({ ctx, selfPod });
      const secretVol = job.spec?.template?.spec?.volumes?.find((v) => v.name === "my-secret");
      expect(secretVol?.secret?.secretName).toBe("app-secret");
      const secretMount = job.spec?.template?.spec?.containers[0]?.volumeMounts?.find((vm) => vm.mountPath === "/secrets/app");
      expect(secretMount?.readOnly).toBe(true);
    });
  });

  describe("environment variables", () => {
    it("sets HOME to /paperclip", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      const home = job.spec?.template?.spec?.containers[0]?.env?.find((e) => e.name === "HOME");
      expect(home?.value).toBe("/paperclip");
    });

    it("inherits env vars from selfPod", () => {
      selfPod.inheritedEnv = { ANTHROPIC_API_KEY: "sk-abc", AWS_REGION: "us-east-1" };
      const { job } = buildJobManifest({ ctx, selfPod });
      const envNames = job.spec?.template?.spec?.containers[0]?.env?.map((e) => e.name) ?? [];
      expect(envNames).toContain("ANTHROPIC_API_KEY");
      expect(envNames).toContain("AWS_REGION");
    });

    it("inherits ANTHROPIC_AUTH_TOKEN from selfPod for API auth", () => {
      selfPod.inheritedEnv = { ANTHROPIC_AUTH_TOKEN: "sk-test" };
      const { job } = buildJobManifest({ ctx, selfPod });
      const envNames = job.spec?.template?.spec?.containers[0]?.env?.map((e) => e.name) ?? [];
      expect(envNames).toContain("ANTHROPIC_AUTH_TOKEN");
    });

    it("user env config overrides inherited env", () => {
      selfPod.inheritedEnv = { AWS_REGION: "us-east-1" };
      ctx.config = { env: { AWS_REGION: "us-west-2" } };
      const { job } = buildJobManifest({ ctx, selfPod });
      const awsRegion = job.spec?.template?.spec?.containers[0]?.env?.find((e) => e.name === "AWS_REGION");
      expect(awsRegion?.value).toBe("us-west-2");
    });

    it("sets PAPERCLIP_RUN_ID", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      const runId = job.spec?.template?.spec?.containers[0]?.env?.find((e) => e.name === "PAPERCLIP_RUN_ID");
      expect(runId?.value).toBe("run-abc12345");
    });

    it("sets PAPERCLIP_API_KEY from authToken", () => {
      ctx.authToken = "pk_abc123";
      const { job } = buildJobManifest({ ctx, selfPod });
      const apiKey = job.spec?.template?.spec?.containers[0]?.env?.find((e) => e.name === "PAPERCLIP_API_KEY");
      expect(apiKey?.value).toBe("pk_abc123");
    });

    it("inherited PAPERCLIP_API_URL from selfPod takes precedence", () => {
      ctx.authToken = "pk_abc";
      selfPod.inheritedEnv = { PAPERCLIP_API_URL: "http://paperclip:8080" };
      const { job } = buildJobManifest({ ctx, selfPod });
      const apiUrl = job.spec?.template?.spec?.containers[0]?.env?.find((e) => e.name === "PAPERCLIP_API_URL");
      expect(apiUrl?.value).toBe("http://paperclip:8080");
    });
  });

  describe("resources", () => {
    it("sets default resource requests and limits", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      const resources = job.spec?.template?.spec?.containers[0]?.resources;
      expect(resources?.requests).toEqual({ cpu: "1000m", memory: "2Gi" });
      expect(resources?.limits).toEqual({ cpu: "4000m", memory: "8Gi" });
    });

    it("uses configured resource overrides", () => {
      ctx.config = {
        resources: {
          requests: { cpu: "500m", memory: "1Gi" },
          limits: { cpu: "2000m", memory: "4Gi" },
        },
      };
      const { job } = buildJobManifest({ ctx, selfPod });
      const resources = job.spec?.template?.spec?.containers[0]?.resources;
      expect(resources?.requests).toEqual({ cpu: "500m", memory: "1Gi" });
      expect(resources?.limits).toEqual({ cpu: "2000m", memory: "4Gi" });
    });
  });

  describe("nodeSelector and tolerations", () => {
    it("applies nodeSelector from config", () => {
      ctx.config = { nodeSelector: { "topology.kubernetes.io/zone": "us-east-1a" } };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.nodeSelector).toEqual({ "topology.kubernetes.io/zone": "us-east-1a" });
    });

    it("applies tolerations from config", () => {
      ctx.config = { tolerations: [{ key: "disk", operator: "Equal", value: "ssd", effect: "NoSchedule" }] };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.tolerations).toHaveLength(1);
    });

    it("omits nodeSelector when empty", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.nodeSelector).toBeUndefined();
    });

    it("omits tolerations when empty", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.tolerations).toBeUndefined();
    });
  });

  describe("claude args", () => {
    it("builds --print - - --output-format stream-json --verbose", () => {
      const { claudeArgs } = buildJobManifest({ ctx, selfPod });
      expect(claudeArgs).toContain("--print");
      expect(claudeArgs).toContain("-");
      expect(claudeArgs).toContain("--output-format");
      expect(claudeArgs).toContain("stream-json");
      expect(claudeArgs).toContain("--verbose");
    });

    it("adds --model when configured", () => {
      ctx.config = { model: "claude-opus-4-6" };
      const { claudeArgs } = buildJobManifest({ ctx, selfPod });
      expect(claudeArgs).toContain("--model");
      expect(claudeArgs).toContain("claude-opus-4-6");
    });

    it("adds --effort when configured", () => {
      ctx.config = { effort: "high" };
      const { claudeArgs } = buildJobManifest({ ctx, selfPod });
      expect(claudeArgs).toContain("--effort");
      expect(claudeArgs).toContain("high");
    });

    it("adds --max-turns when configured", () => {
      ctx.config = { maxTurnsPerRun: 10 };
      const { claudeArgs } = buildJobManifest({ ctx, selfPod });
      expect(claudeArgs).toContain("--max-turns");
      expect(claudeArgs).toContain("10");
    });

    it("adds --resume when sessionId present", () => {
      ctx.runtime.sessionId = "sess_abc";
      const { claudeArgs } = buildJobManifest({ ctx, selfPod });
      expect(claudeArgs).toContain("--resume");
      expect(claudeArgs).toContain("sess_abc");
    });

    it("adds --dangerously-skip-permissions by default", () => {
      const { claudeArgs } = buildJobManifest({ ctx, selfPod });
      expect(claudeArgs).toContain("--dangerously-skip-permissions");
    });

    it("adds --append-system-prompt-file when instructionsFilePath set", () => {
      ctx.config = { instructionsFilePath: "/paperclip/instructions.md" };
      const { claudeArgs } = buildJobManifest({ ctx, selfPod });
      expect(claudeArgs).toContain("--append-system-prompt-file");
      expect(claudeArgs).toContain("/paperclip/instructions.md");
    });

    it("appends extraArgs when configured", () => {
      ctx.config = { extraArgs: ["--no-input", "--verbose"] };
      const { claudeArgs } = buildJobManifest({ ctx, selfPod });
      expect(claudeArgs).toContain("--no-input");
      expect(claudeArgs).toContain("--verbose");
    });
  });

  describe("prompt rendering", () => {
    it("includes agent name in default prompt template", () => {
      const { prompt } = buildJobManifest({ ctx, selfPod });
      expect(prompt).toContain("Test Agent");
    });

    it("uses custom promptTemplate when set", () => {
      ctx.config = { promptTemplate: "You are a helpful assistant." };
      const { prompt } = buildJobManifest({ ctx, selfPod });
      expect(prompt).toBe("You are a helpful assistant.");
    });

    it("includes workspace context in prompt when available", () => {
      ctx.context = {
        paperclipWorkspace: {
          cwd: "/project",
          strategy: "read-only",
          workspaceId: "ws1",
          repoUrl: "https://github.com/org/repo",
          branchName: "main",
        },
      };
      const { prompt } = buildJobManifest({ ctx, selfPod });
      expect(prompt).toContain("Test Agent");
    });

    it("returns promptMetrics with char counts", () => {
      const { promptMetrics } = buildJobManifest({ ctx, selfPod });
      expect(promptMetrics.promptChars).toBeGreaterThan(0);
      expect(typeof promptMetrics.promptChars).toBe("number");
    });
  });

  describe("serviceAccountName", () => {
    it("sets custom serviceAccountName when configured", () => {
      ctx.config = { serviceAccountName: "paperclip-agent" };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.serviceAccountName).toBe("paperclip-agent");
    });

    it("omits serviceAccountName when not configured", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.serviceAccountName).toBeUndefined();
    });
  });

  describe("namespace", () => {
    it("uses selfPod namespace by default", () => {
      const { namespace } = buildJobManifest({ ctx, selfPod });
      expect(namespace).toBe("paperclip");
    });

    it("uses configured namespace override", () => {
      ctx.config = { namespace: "agents" };
      const { namespace, job } = buildJobManifest({ ctx, selfPod });
      expect(namespace).toBe("agents");
      expect(job.metadata?.namespace).toBe("agents");
    });
  });

  describe("RTK integration", () => {
    it("does not add RTK init container by default", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      const inits = job.spec?.template?.spec?.initContainers ?? [];
      expect(inits).toHaveLength(1);
      expect(inits[0]?.name).toBe("write-prompt");
    });

    it("adds install-rtk init container when enableRtk is true", () => {
      ctx.config = { enableRtk: true };
      const { job } = buildJobManifest({ ctx, selfPod });
      const inits = job.spec?.template?.spec?.initContainers ?? [];
      expect(inits).toHaveLength(2);
      expect(inits[1]?.name).toBe("install-rtk");
      expect(inits[1]?.image).toBe("curlimages/curl:8.12.1");
    });

    it("uses custom rtkImage for init container", () => {
      ctx.config = { enableRtk: true, rtkImage: "my-registry/rtk-installer:v1" };
      const { job } = buildJobManifest({ ctx, selfPod });
      const inits = job.spec?.template?.spec?.initContainers ?? [];
      const rtkInit = inits.find((c) => c.name === "install-rtk");
      expect(rtkInit?.image).toBe("my-registry/rtk-installer:v1");
    });

    it("adds rtk-bin emptyDir volume when enableRtk is true", () => {
      ctx.config = { enableRtk: true };
      const { job } = buildJobManifest({ ctx, selfPod });
      const rtkVol = job.spec?.template?.spec?.volumes?.find((v) => v.name === "rtk-bin");
      expect(rtkVol?.emptyDir).toEqual({});
    });

    it("mounts rtk-bin in main container when enableRtk is true", () => {
      ctx.config = { enableRtk: true };
      const { job } = buildJobManifest({ ctx, selfPod });
      const rtkMount = job.spec?.template?.spec?.containers[0]?.volumeMounts?.find(
        (vm) => vm.name === "rtk-bin",
      );
      expect(rtkMount?.mountPath).toBe("/tmp/rtk-bin");
    });

    it("prepends rtk setup to main command with project-level settings isolation", () => {
      ctx.config = { enableRtk: true };
      const { job } = buildJobManifest({ ctx, selfPod });
      const command = job.spec?.template?.spec?.containers[0]?.command;
      expect(command?.[2]).toContain('export PATH="/tmp/rtk-bin:$PATH"');
      expect(command?.[2]).toContain("rtk install claude-code");
      expect(command?.[2]).toContain("settings.local.json");
      expect(command?.[2]).toContain("export HOME=/paperclip");
      expect(command?.[2]).toContain("cat /tmp/prompt/prompt.txt | claude");
    });

    it("does not prepend rtk setup when enableRtk is false", () => {
      ctx.config = { enableRtk: false };
      const { job } = buildJobManifest({ ctx, selfPod });
      const command = job.spec?.template?.spec?.containers[0]?.command;
      expect(command?.[2]).not.toContain("rtk");
      expect(command?.[2]).toMatch(/^cat \/tmp\/prompt\/prompt\.txt/);
    });

    it("does not add rtk-bin volume when enableRtk is false", () => {
      ctx.config = { enableRtk: false };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.volumes?.find((v) => v.name === "rtk-bin")).toBeUndefined();
    });

    it("sets RTK_NO_TELEMETRY env var when enableRtk is true", () => {
      ctx.config = { enableRtk: true };
      const { job } = buildJobManifest({ ctx, selfPod });
      const rtkTelemetry = job.spec?.template?.spec?.containers[0]?.env?.find(
        (e) => e.name === "RTK_NO_TELEMETRY",
      );
      expect(rtkTelemetry?.value).toBe("1");
    });

    it("does not set RTK_NO_TELEMETRY when enableRtk is false", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      const rtkTelemetry = job.spec?.template?.spec?.containers[0]?.env?.find(
        (e) => e.name === "RTK_NO_TELEMETRY",
      );
      expect(rtkTelemetry).toBeUndefined();
    });

    it("uses custom rtkVersion in install command", () => {
      ctx.config = { enableRtk: true, rtkVersion: "0.5.0" };
      const { job } = buildJobManifest({ ctx, selfPod });
      const inits = job.spec?.template?.spec?.initContainers ?? [];
      const rtkInit = inits.find((c) => c.name === "install-rtk");
      expect(rtkInit?.command?.[2]).toContain("RTK_VERSION=0.5.0");
    });

    it("mounts rtk-bin in install-rtk init container", () => {
      ctx.config = { enableRtk: true };
      const { job } = buildJobManifest({ ctx, selfPod });
      const inits = job.spec?.template?.spec?.initContainers ?? [];
      const rtkInit = inits.find((c) => c.name === "install-rtk");
      expect(rtkInit?.volumeMounts).toContainEqual({ name: "rtk-bin", mountPath: "/tmp/rtk-bin" });
    });

    it("writes hooks to workspace .claude/settings.local.json not global settings", () => {
      ctx.context = { paperclipWorkspace: { cwd: "/paperclip/workspaces/agent-abc" } };
      ctx.config = { enableRtk: true };
      const { job } = buildJobManifest({ ctx, selfPod });
      const command = job.spec?.template?.spec?.containers[0]?.command;
      expect(command?.[2]).toContain("/paperclip/workspaces/agent-abc/.claude");
      expect(command?.[2]).toContain("settings.local.json");
      expect(command?.[2]).not.toMatch(/HOME="\/paperclip".*rtk install/);
    });
  });

  describe("return value", () => {
    it("returns job, jobName, namespace, prompt, claudeArgs, promptMetrics", () => {
      const result = buildJobManifest({ ctx, selfPod });
      expect(result.job).toBeDefined();
      expect(result.jobName).toBeDefined();
      expect(result.namespace).toBeDefined();
      expect(result.prompt).toBeDefined();
      expect(result.claudeArgs).toBeDefined();
      expect(result.promptMetrics).toBeDefined();
    });
  });
});
