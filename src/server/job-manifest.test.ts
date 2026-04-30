import { describe, it, expect, beforeEach } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { buildJobManifest, buildPodLogPath, sanitizeLabelValue } from "./job-manifest.js";
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
    inheritedEnvValueFrom: [],
    inheritedEnvFrom: [],
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
    it("uses ac- prefix", () => {
      const { jobName } = buildJobManifest({ ctx, selfPod });
      expect(jobName).toMatch(/^ac-/);
    });

    it("includes sanitized agent id slug (up to 16 chars)", () => {
      ctx.agent.id = "Agent-ABC!@#";
      const { jobName } = buildJobManifest({ ctx, selfPod });
      // sanitizeForK8sName: lowercase, strip non-alphanumeric (not dashes), slice 0-16
      expect(jobName).toContain("agent-abc");
    });

    it("includes sanitized run id slug (up to 16 chars)", () => {
      ctx.runId = "RUN-ABC-12345";
      const { jobName } = buildJobManifest({ ctx, selfPod });
      expect(jobName).toContain("run-abc-12345");
    });

    it("includes a deterministic hash suffix", () => {
      const result1 = buildJobManifest({ ctx, selfPod });
      const result2 = buildJobManifest({ ctx, selfPod });
      expect(result1.jobName).toBe(result2.jobName);
      // Hash suffix is 6 hex chars at the end
      expect(result1.jobName).toMatch(/-[0-9a-f]{6}$/);
    });

    it("different agent+run pairs produce different names", () => {
      const result1 = buildJobManifest({ ctx, selfPod });
      ctx.runId = "run-different";
      const result2 = buildJobManifest({ ctx, selfPod });
      expect(result1.jobName).not.toBe(result2.jobName);
    });

    it("stays within 63-char DNS label limit", () => {
      ctx.agent.id = "a".repeat(100);
      ctx.runId = "r".repeat(100);
      const { jobName } = buildJobManifest({ ctx, selfPod });
      expect(jobName.length).toBeLessThanOrEqual(63);
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

    it("adds task-id label when context provides taskId", () => {
      ctx.context = { taskId: "task-xyz-789" };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.metadata?.labels?.["paperclip.io/task-id"]).toBe("task-xyz-789");
    });

    it("falls back to issueId when taskId absent", () => {
      ctx.context = { issueId: "issue-42" };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.metadata?.labels?.["paperclip.io/task-id"]).toBe("issue-42");
    });

    it("adds session-id label when runtime provides sessionId", () => {
      ctx.runtime = { ...ctx.runtime, sessionId: "sess-abc-1234" };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.metadata?.labels?.["paperclip.io/session-id"]).toBe("sess-abc-1234");
    });

    it("reads sessionId from runtime.sessionParams when sessionId prop missing", () => {
      ctx.runtime = { ...ctx.runtime, sessionParams: { sessionId: "sess-from-params" } };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.metadata?.labels?.["paperclip.io/session-id"]).toBe("sess-from-params");
    });

    it("omits task-id and session-id labels when neither is provided", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.metadata?.labels?.["paperclip.io/task-id"]).toBeUndefined();
      expect(job.metadata?.labels?.["paperclip.io/session-id"]).toBeUndefined();
    });

    it("drops user label with paperclip.io/ prefix", () => {
      ctx.config = { labels: { "paperclip.io/run-id": "hijacked" } };
      const { job, skippedLabels } = buildJobManifest({ ctx, selfPod });
      expect(job.metadata?.labels?.["paperclip.io/run-id"]).not.toBe("hijacked");
      expect(skippedLabels).toContain("paperclip.io/run-id");
    });

    it("drops user label with app.kubernetes.io/ prefix", () => {
      ctx.config = { labels: { "app.kubernetes.io/managed-by": "attacker" } };
      const { job, skippedLabels } = buildJobManifest({ ctx, selfPod });
      expect(job.metadata?.labels?.["app.kubernetes.io/managed-by"]).toBe("paperclip");
      expect(skippedLabels).toContain("app.kubernetes.io/managed-by");
    });

    it("passes through user label without reserved prefix", () => {
      ctx.config = { labels: { "custom.io/team": "platform" } };
      const { job, skippedLabels } = buildJobManifest({ ctx, selfPod });
      expect(job.metadata?.labels?.["custom.io/team"]).toBe("platform");
      expect(skippedLabels).not.toContain("custom.io/team");
    });

    it("populates skippedLabels with all dropped keys", () => {
      ctx.config = {
        labels: {
          "paperclip.io/agent-id": "x",
          "app.kubernetes.io/component": "y",
          "safe": "z",
        },
      };
      const { skippedLabels } = buildJobManifest({ ctx, selfPod });
      expect(skippedLabels).toHaveLength(2);
      expect(skippedLabels).toContain("paperclip.io/agent-id");
      expect(skippedLabels).toContain("app.kubernetes.io/component");
    });
  });

  describe("system label sanitization (N4)", () => {
    it("sanitizes agent.id with @ to a valid RFC 1123 label", () => {
      ctx.agent.id = "user@example.com";
      const { job } = buildJobManifest({ ctx, selfPod });
      const label = job.metadata?.labels?.["paperclip.io/agent-id"];
      expect(label).toMatch(/^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$/);
      expect(label).not.toContain("@");
    });

    it("sanitizes agent.id with spaces to a valid RFC 1123 label", () => {
      ctx.agent.id = "my agent id";
      const { job } = buildJobManifest({ ctx, selfPod });
      const label = job.metadata?.labels?.["paperclip.io/agent-id"];
      expect(label).toMatch(/^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$/);
    });

    it("omits paperclip.io/run-id when sanitized value is null (all-invalid runId)", () => {
      // inject an all-special-chars runId via context override — buildJobManifest
      // uses ctx.runId directly. Use characters that are path-valid but label-invalid.
      const badCtx = makeCtx({ runId: "@@@" });
      expect(() => buildJobManifest({ ctx: badCtx, selfPod })).toThrow("Invalid runId");
    });

    it("selector matches sanitized agent-id label", () => {
      ctx.agent.id = "Agent@Test";
      const { job } = buildJobManifest({ ctx, selfPod });
      const agentLabel = job.metadata?.labels?.["paperclip.io/agent-id"];
      // the label should equal what sanitizeLabelValue produces
      expect(agentLabel).toBe("AgentTest");
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
      expect(init?.command?.[0]).toBe("sh");
      expect(init?.command?.[1]).toBe("-c");
      expect(init?.command?.[2]).toBe("printf '%s' \"$PROMPT_CONTENT\" > /tmp/prompt/prompt.txt");
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

    it("includes valueFrom env vars from selfPod", () => {
      selfPod.inheritedEnvValueFrom = [
        { name: "ANTHROPIC_API_KEY", valueFrom: { secretKeyRef: { name: "api-keys", key: "anthropic" } } },
      ];
      const { job } = buildJobManifest({ ctx, selfPod });
      const envList = job.spec?.template?.spec?.containers[0]?.env ?? [];
      const apiKeyEntry = envList.find((e) => e.name === "ANTHROPIC_API_KEY");
      expect(apiKeyEntry?.valueFrom?.secretKeyRef?.name).toBe("api-keys");
      expect(apiKeyEntry?.valueFrom?.secretKeyRef?.key).toBe("anthropic");
      expect(apiKeyEntry?.value).toBeUndefined();
    });

    it("literal env overrides valueFrom with the same name", () => {
      selfPod.inheritedEnv = { MY_VAR: "literal-value" };
      selfPod.inheritedEnvValueFrom = [
        { name: "MY_VAR", valueFrom: { secretKeyRef: { name: "sec", key: "k" } } },
      ];
      const { job } = buildJobManifest({ ctx, selfPod });
      const envList = job.spec?.template?.spec?.containers[0]?.env ?? [];
      const myVar = envList.filter((e) => e.name === "MY_VAR");
      expect(myVar).toHaveLength(1);
      expect(myVar[0]?.value).toBe("literal-value");
      expect(myVar[0]?.valueFrom).toBeUndefined();
    });

    it("includes envFrom sources from selfPod on the container", () => {
      selfPod.inheritedEnvFrom = [
        { secretRef: { name: "api-secrets" } },
        { configMapRef: { name: "app-config" } },
      ];
      const { job } = buildJobManifest({ ctx, selfPod });
      const container = job.spec?.template?.spec?.containers[0];
      expect(container?.envFrom).toHaveLength(2);
      expect(container?.envFrom?.[0]?.secretRef?.name).toBe("api-secrets");
      expect(container?.envFrom?.[1]?.configMapRef?.name).toBe("app-config");
    });

    it("omits envFrom when selfPod has none", () => {
      selfPod.inheritedEnvFrom = [];
      const { job } = buildJobManifest({ ctx, selfPod });
      const container = job.spec?.template?.spec?.containers[0];
      expect(container?.envFrom).toBeUndefined();
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
        "resources.requests.cpu": "500m",
        "resources.requests.memory": "1Gi",
        "resources.limits.cpu": "2000m",
        "resources.limits.memory": "4Gi",
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

    it("adds --append-system-prompt-file (config fallback) when instructionsFilePath set and no session", () => {
      ctx.config = { instructionsFilePath: "/paperclip/instructions.md" };
      const { claudeArgs } = buildJobManifest({ ctx, selfPod });
      expect(claudeArgs).toContain("--append-system-prompt-file");
      expect(claudeArgs).toContain("/paperclip/instructions.md");
    });

    it("omits --append-system-prompt-file on session resume (avoids token waste)", () => {
      ctx.config = { instructionsFilePath: "/paperclip/instructions.md" };
      ctx.runtime.sessionId = "sess_existing";
      const { claudeArgs } = buildJobManifest({ ctx, selfPod });
      expect(claudeArgs).not.toContain("--append-system-prompt-file");
    });

    it("adds --add-dir when promptBundle is provided", () => {
      const promptBundle = {
        bundleKey: "abc123",
        rootDir: "/paperclip/instances/default/companies/co1/claude-prompt-cache/abc123",
        addDir: "/paperclip/instances/default/companies/co1/claude-prompt-cache/abc123",
        instructionsFilePath: null,
      };
      const { claudeArgs } = buildJobManifest({ ctx, selfPod, promptBundle });
      expect(claudeArgs).toContain("--add-dir");
      expect(claudeArgs).toContain(promptBundle.addDir);
    });

    it("uses bundle instructionsFilePath for --append-system-prompt-file when promptBundle provided", () => {
      const promptBundle = {
        bundleKey: "abc123",
        rootDir: "/paperclip/instances/default/companies/co1/claude-prompt-cache/abc123",
        addDir: "/paperclip/instances/default/companies/co1/claude-prompt-cache/abc123",
        instructionsFilePath: "/paperclip/instances/default/companies/co1/claude-prompt-cache/abc123/agent-instructions.md",
      };
      ctx.config = { instructionsFilePath: "/raw/path/AGENTS.md" };
      const { claudeArgs } = buildJobManifest({ ctx, selfPod, promptBundle });
      expect(claudeArgs).toContain("--append-system-prompt-file");
      const idx = claudeArgs.indexOf("--append-system-prompt-file");
      expect(claudeArgs[idx + 1]).toBe(promptBundle.instructionsFilePath);
      expect(claudeArgs).not.toContain("/raw/path/AGENTS.md");
    });

    it("omits --append-system-prompt-file from bundle on session resume", () => {
      const promptBundle = {
        bundleKey: "abc123",
        rootDir: "/paperclip/instances/default/companies/co1/claude-prompt-cache/abc123",
        addDir: "/paperclip/instances/default/companies/co1/claude-prompt-cache/abc123",
        instructionsFilePath: "/paperclip/instances/default/companies/co1/claude-prompt-cache/abc123/agent-instructions.md",
      };
      ctx.runtime.sessionId = "sess_existing";
      const { claudeArgs } = buildJobManifest({ ctx, selfPod, promptBundle });
      expect(claudeArgs).not.toContain("--append-system-prompt-file");
      // --add-dir must still be present even on resume
      expect(claudeArgs).toContain("--add-dir");
    });

    it("omits --add-dir when no promptBundle", () => {
      const { claudeArgs } = buildJobManifest({ ctx, selfPod });
      expect(claudeArgs).not.toContain("--add-dir");
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

  describe("return value", () => {
    it("returns job, jobName, namespace, prompt, claudeArgs, promptMetrics, promptSecret", () => {
      const result = buildJobManifest({ ctx, selfPod });
      expect(result.job).toBeDefined();
      expect(result.jobName).toBeDefined();
      expect(result.namespace).toBeDefined();
      expect(result.prompt).toBeDefined();
      expect(result.claudeArgs).toBeDefined();
      expect(result.promptMetrics).toBeDefined();
      expect(result.promptSecret).toBeNull();
    });
  });

  describe("nodeSelector key=value parsing", () => {
    it("parses key=value multiline text", () => {
      ctx.config = { nodeSelector: "disktype=ssd\ntopology.kubernetes.io/zone=us-east-1a" };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.nodeSelector).toEqual({
        disktype: "ssd",
        "topology.kubernetes.io/zone": "us-east-1a",
      });
    });

    it("still accepts JSON objects", () => {
      ctx.config = { nodeSelector: { disktype: "ssd" } };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.nodeSelector).toEqual({ disktype: "ssd" });
    });

    it("parses JSON string format", () => {
      ctx.config = { nodeSelector: '{"disktype":"ssd"}' };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.nodeSelector).toEqual({ disktype: "ssd" });
    });

    it("skips comment lines and blank lines", () => {
      ctx.config = { nodeSelector: "# comment\n\ndisktype=ssd\n" };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.nodeSelector).toEqual({ disktype: "ssd" });
    });
  });

  describe("labels key=value parsing", () => {
    it("parses key=value multiline text for extra labels", () => {
      ctx.config = { labels: "env=prod\nteam=platform" };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.metadata?.labels?.env).toBe("prod");
      expect(job.metadata?.labels?.team).toBe("platform");
    });
  });

  describe("large prompt Secret fallback", () => {
    it("returns null promptSecret for small prompts", () => {
      const { promptSecret } = buildJobManifest({ ctx, selfPod });
      expect(promptSecret).toBeNull();
    });

    it("returns promptSecret for prompts >256 KiB", () => {
      // Build a prompt >256 KiB via a custom template
      const largePrompt = "x".repeat(300 * 1024);
      ctx.config = { promptTemplate: largePrompt };
      const { promptSecret, job } = buildJobManifest({ ctx, selfPod });
      expect(promptSecret).not.toBeNull();
      expect(promptSecret!.data["prompt.txt"]).toBe(largePrompt);
      // Init container should copy from secret volume, not use PROMPT_CONTENT env
      const init = job.spec?.template?.spec?.initContainers?.[0];
      expect(init?.command).toContainEqual(expect.stringContaining("cp"));
      expect(init?.env).toBeUndefined();
      // Should have prompt-secret volume
      const secretVol = job.spec?.template?.spec?.volumes?.find((v) => v.name === "prompt-secret");
      expect(secretVol?.secret?.secretName).toBe(promptSecret!.name);
    });

    it("uses env var init container for small prompts", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      const init = job.spec?.template?.spec?.initContainers?.[0];
      expect(init?.env?.[0]?.name).toBe("PROMPT_CONTENT");
    });
  });

  describe("pod log file tailing", () => {
    it("does not modify main command when enableRtk is false (default)", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      const cmd = job.spec?.template?.spec?.containers[0]?.command;
      // Command should be the plain `cat ... | claude ... | tee ...` form with no rtk setup
      expect(cmd?.[2]).toMatch(/^cat \/tmp\/prompt\/prompt\.txt \| claude .* \| tee /);
      expect(cmd?.[2]).not.toContain("rtk-filter");
    });

    it("command includes tee to pod log path", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      const cmd = job.spec?.template?.spec?.containers[0]?.command?.[2] ?? "";
      expect(cmd).toContain("| tee");
      expect(cmd).toContain("/paperclip/instances/default/data/run-logs/");
    });

    it("podLogPath is returned from buildJobManifest", () => {
      const result = buildJobManifest({ ctx, selfPod });
      expect(result.podLogPath).toBe(
        "/paperclip/instances/default/data/run-logs/co1/agent-abc/run-abc12345.pod.ndjson",
      );
    });

    it("buildPodLogPath returns correctly formatted path", () => {
      expect(buildPodLogPath("co1", "agent-abc", "run-abc12345")).toBe(
        "/paperclip/instances/default/data/run-logs/co1/agent-abc/run-abc12345.pod.ndjson",
      );
    });

    it("init container does not create log directory (server pre-creates it on shared PVC)", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      const initCmd = job.spec?.template?.spec?.initContainers?.[0]?.command;
      expect(initCmd?.[2]).not.toContain("mkdir -p /paperclip");
    });

    it("sanitizes companyId with / to valid path component for log path", () => {
      const badCtx = {
        ...ctx,
        agent: { ...ctx.agent, companyId: "co/1" },
      };
      const { podLogPath } = buildJobManifest({ ctx: badCtx as typeof ctx, selfPod });
      // / is stripped by sanitizeForK8sPath
      expect(podLogPath).toContain("co1/");
    });

    it("sanitizes agentId with @ to valid path component for log path", () => {
      const badCtx = {
        ...ctx,
        agent: { ...ctx.agent, id: "agent@123" },
      };
      const { podLogPath } = buildJobManifest({ ctx: badCtx as typeof ctx, selfPod });
      // @ is stripped by sanitizeForK8sPath
      expect(podLogPath).toContain("/agent123/");
    });

    it("sanitizes runId with underscore to valid path component for log path", () => {
      const badCtx = {
        ...ctx,
        runId: "run_123",
      };
      const { podLogPath } = buildJobManifest({ ctx: badCtx as typeof ctx, selfPod });
      // _ is stripped by sanitizeForK8sPath
      expect(podLogPath).toContain("/run123.pod.ndjson");
    });
  });
});

describe("sanitizeLabelValue", () => {
  it("passes through already-valid UUIDs and slugs", () => {
    expect(sanitizeLabelValue("abc-123-def")).toBe("abc-123-def");
    expect(sanitizeLabelValue("0d8b4472-c42c-4052-aab1-e32897909afa")).toBe("0d8b4472-c42c-4052-aab1-e32897909afa");
  });

  it("strips characters outside [a-zA-Z0-9._-]", () => {
    expect(sanitizeLabelValue("task:xyz/123")).toBe("taskxyz123");
    expect(sanitizeLabelValue("abc 123")).toBe("abc123");
  });

  it("trims leading/trailing non-alphanumeric characters", () => {
    expect(sanitizeLabelValue("--abc--")).toBe("abc");
    expect(sanitizeLabelValue("...123...")).toBe("123");
  });

  it("truncates to the configured maxLen", () => {
    const long = "a".repeat(200);
    const out = sanitizeLabelValue(long, 63);
    expect(out?.length).toBe(63);
  });

  it("returns null when no alphanumeric characters remain", () => {
    expect(sanitizeLabelValue("---")).toBeNull();
    expect(sanitizeLabelValue("")).toBeNull();
    expect(sanitizeLabelValue("   ")).toBeNull();
  });
});
