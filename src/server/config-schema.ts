// NOTE: These types must match what Paperclip's SchemaConfigFields component
// expects. Paperclip's server at GET /api/adapters/:type/config-schema
// calls adapter.getConfigSchema() and the UI reads the JSON — types are only
// used at build time here. The Paperclip types in @paperclipai/adapter-utils
// may lag behind; these locals are the source of truth for this adapter.

interface ConfigFieldOption {
  label: string;
  value: string;
  group?: string;
}

type ConfigFieldSchema =
  | { type: "text"; key: string; label: string; hint?: string; default?: unknown; meta?: Record<string, unknown> }
  | { type: "number"; key: string; label: string; hint?: string; default?: unknown; meta?: Record<string, unknown> }
  | { type: "toggle"; key: string; label: string; hint?: string; default?: unknown; meta?: Record<string, unknown> }
  | { type: "select"; key: string; label: string; hint?: string; options: ConfigFieldOption[]; default?: unknown; meta?: Record<string, unknown> }
  | { type: "textarea"; key: string; label: string; hint?: string; default?: unknown; meta?: Record<string, unknown> }
  | { type: "combobox"; key: string; label: string; hint?: string; options?: ConfigFieldOption[]; default?: unknown; meta?: Record<string, unknown> };

interface AdapterConfigSchema {
  fields: ConfigFieldSchema[];
}

export function getConfigSchema(): AdapterConfigSchema {
  const fields: ConfigFieldSchema[] = [
    // Core Claude fields
    {
      type: "select",
      key: "model",
      label: "Model",
      hint: "Claude model to use for this agent.",
      options: [
        { value: "claude-opus-4-6", label: "Claude Opus 4.6" },
        { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
        { value: "claude-haiku-4-6", label: "Claude Haiku 4.6" },
        { value: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5" },
        { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
      ],
    },
    {
      type: "select",
      key: "effort",
      label: "Reasoning Effort",
      hint: "Reasoning effort level passed via --effort.",
      options: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
      ],
    },
    {
      type: "number",
      key: "maxTurnsPerRun",
      label: "Max Turns Per Run",
      hint: "Maximum number of turns for a single run. 0 means unlimited.",
    },
    {
      type: "toggle",
      key: "dangerouslySkipPermissions",
      label: "Skip Permissions",
      hint: "Pass --dangerously-skip-permissions to Claude. Enabled by default for unattended K8s Jobs.",
      default: true,
    },
    {
      type: "text",
      key: "instructionsFilePath",
      label: "Instructions File Path",
      hint: "Absolute path to a markdown instructions file injected at runtime via --append-system-prompt-file.",
    },
    // Operational
    {
      type: "number",
      key: "timeoutSec",
      label: "Timeout (seconds)",
      hint: "Run timeout in seconds. 0 means no timeout.",
    },
    {
      type: "number",
      key: "graceSec",
      label: "Grace Period (seconds)",
      hint: "Additional grace period before adapter gives up after Job deadline. Default: 60.",
    },
    // Kubernetes
    {
      type: "text",
      key: "namespace",
      label: "Namespace",
      hint: "Kubernetes namespace for Jobs. Defaults to the Deployment namespace.",
    },
    {
      type: "text",
      key: "image",
      label: "Container Image",
      hint: "Override the container image used for Job pods. Defaults to the running Deployment image.",
    },
    {
      type: "select",
      key: "imagePullPolicy",
      label: "Image Pull Policy",
      hint: "Image pull policy for the container image.",
      options: [
        { value: "IfNotPresent", label: "IfNotPresent" },
        { value: "Always", label: "Always" },
        { value: "Never", label: "Never" },
      ],
    },
    {
      type: "text",
      key: "kubeconfig",
      label: "Kubeconfig Path",
      hint: "Absolute path to a kubeconfig file on disk. Defaults to in-cluster service account auth.",
    },
    {
      type: "number",
      key: "ttlSecondsAfterFinished",
      label: "TTL Seconds After Finished",
      hint: "Auto-cleanup delay for completed Jobs in seconds. Default: 300.",
    },
    {
      type: "toggle",
      key: "retainJobs",
      label: "Retain Jobs",
      hint: "Skip cleanup of completed Jobs for debugging purposes.",
    },
    // Resource Limits
    {
      type: "text",
      key: "resources.requests.cpu",
      label: "CPU Request",
      hint: "CPU request for Job pods (e.g. 100m, 0.5, 1).",
    },
    {
      type: "text",
      key: "resources.requests.memory",
      label: "Memory Request",
      hint: "Memory request for Job pods (e.g. 128Mi, 512Mi, 1Gi).",
    },
    {
      type: "text",
      key: "resources.limits.cpu",
      label: "CPU Limit",
      hint: "CPU limit for Job pods (e.g. 100m, 0.5, 1).",
    },
    {
      type: "text",
      key: "resources.limits.memory",
      label: "Memory Limit",
      hint: "Memory limit for Job pods (e.g. 128Mi, 512Mi, 1Gi).",
    },
    // Scheduling
    {
      type: "textarea",
      key: "nodeSelector",
      label: "Node Selector",
      hint: "Node selector for Job pods. One key=value per line (e.g. disktype=ssd).",
    },
    {
      type: "textarea",
      key: "tolerations",
      label: "Tolerations",
      hint: "Tolerations for Job pods as JSON array.",
    },
    {
      type: "textarea",
      key: "labels",
      label: "Labels",
      hint: "Extra labels added to Job metadata. One key=value per line.",
    },
  ];

  return { fields };
}
