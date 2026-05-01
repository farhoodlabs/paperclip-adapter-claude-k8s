> **Abandoned** — This adapter is no longer maintained. The Kubernetes execution capability has moved to the sandbox plugin at [`farhoodlabs/paperclip-plugin-k8s`](https://github.com/farhoodlabs/paperclip-plugin-k8s) (`@farhoodlabs/paperclip-plugin-k8s` on npm).

# Claude (Kubernetes) Paperclip Adapter Plugin

Paperclip adapter plugin that runs Claude Code agents as isolated Kubernetes Jobs instead of inside the main Paperclip process.

## Features

- Spawns agent runs as K8s Jobs with full pod isolation
- Inherits container image, secrets, DNS, and PVC from the Paperclip Deployment automatically
- Real-time log streaming from Job pods back to the Paperclip UI
- Session resume via shared RWX PVC
- Per-agent concurrency guard
- Configurable resources, namespace, kubeconfig
- Bedrock model support

## Requirements

### Kubernetes Cluster

A running Kubernetes cluster (1.25+) with the Paperclip controller deployed. The adapter runs inside the Paperclip pod and uses the in-cluster service account to create Jobs.

### ReadWriteMany (RWX) PersistentVolumeClaim

**This is the most important infrastructure requirement.** The Paperclip Deployment and every agent Job pod must share a single PVC mounted at `/paperclip`. This volume holds:

- Agent session state (Claude Code sessions for resume across heartbeats)
- Workspace files (git checkouts, project data)
- Agent home directories and memory

The PVC **must** use `ReadWriteMany` (RWX) access mode because the main Paperclip pod and one or more Job pods need to read and write the volume concurrently. `ReadWriteOnce` (RWO) will cause Job pods to fail to mount the volume when they are scheduled on a different node than the Paperclip Deployment.

Storage backends that support RWX include NFS, CephFS, GlusterFS, Azure Files, Amazon EFS, and GCP Filestore. Check your cloud provider or storage class documentation.

Example PVC:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: paperclip-data
  namespace: paperclip
spec:
  accessModes:
    - ReadWriteMany
  storageClassName: efs-sc  # or your RWX-capable StorageClass
  resources:
    requests:
      storage: 50Gi
```

Mount this PVC in the Paperclip Deployment at `/paperclip`:

```yaml
# In the Paperclip Deployment spec
volumes:
  - name: data
    persistentVolumeClaim:
      claimName: paperclip-data

containers:
  - name: paperclip
    volumeMounts:
      - name: data
        mountPath: /paperclip
```

The adapter automatically discovers the PVC claim name from the running pod and forwards it to every Job it creates. No additional volume configuration is needed in the adapter config.

### RBAC

The Paperclip pod's service account needs permissions to create and manage Jobs, list Pods, and stream Pod logs. The adapter also performs a self-check using `SelfSubjectAccessReview` to validate permissions at startup.

Below is a minimal Role and RoleBinding scoped to the `paperclip` namespace:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: paperclip
  namespace: paperclip
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: paperclip-adapter
  namespace: paperclip
rules:
  # Job lifecycle — create, monitor, and clean up agent Jobs
  - apiGroups: ["batch"]
    resources: ["jobs"]
    verbs: ["create", "get", "list", "delete"]

  # Pod discovery — find the Job's pod and check scheduling status
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list"]

  # Log streaming — stream agent output back to the Paperclip UI
  - apiGroups: [""]
    resources: ["pods/log"]
    verbs: ["get"]

  # Self-introspection — read own pod spec to inherit image, PVC, secrets
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get"]

  # PVC health check — verify PVC exists and has RWX access mode
  - apiGroups: [""]
    resources: ["persistentvolumeclaims"]
    verbs: ["get"]

  # Secret health check — verify API key secret exists
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get"]

  # RBAC self-test — adapter validates its own permissions at startup
  - apiGroups: ["authorization.k8s.io"]
    resources: ["selfsubjectaccessreviews"]
    verbs: ["create"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: paperclip-adapter
  namespace: paperclip
subjects:
  - kind: ServiceAccount
    name: paperclip
    namespace: paperclip
roleRef:
  kind: Role
  name: paperclip-adapter
  apiGroup: rbac.authorization.k8s.io
```

> **Note:** `SelfSubjectAccessReview` is a cluster-scoped resource. The above Role grants namespace-scoped permissions which cover Jobs, Pods, and PVCs. The `selfsubjectaccessreviews` permission is typically available cluster-wide to all authenticated users. If your cluster restricts it, add a ClusterRole:
>
> ```yaml
> apiVersion: rbac.authorization.k8s.io/v1
> kind: ClusterRole
> metadata:
>   name: paperclip-self-review
> rules:
>   - apiGroups: ["authorization.k8s.io"]
>     resources: ["selfsubjectaccessreviews"]
>     verbs: ["create"]
> ---
> apiVersion: rbac.authorization.k8s.io/v1
> kind: ClusterRoleBinding
> metadata:
>   name: paperclip-self-review
> subjects:
>   - kind: ServiceAccount
>     name: paperclip
>     namespace: paperclip
> roleRef:
>   kind: ClusterRole
>   name: paperclip-self-review
>   apiGroup: rbac.authorization.k8s.io
> ```

If Jobs run in a **different namespace** than the Paperclip Deployment (via the `namespace` config option), you must also grant the service account permission to read that namespace:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: paperclip-cross-namespace
rules:
  - apiGroups: [""]
    resources: ["namespaces"]
    verbs: ["get"]
```

### API Key Secret

The Paperclip Deployment should have API provider secrets (e.g., `ANTHROPIC_API_KEY`) available as environment variables. These are automatically forwarded to every Job pod. A common pattern is a Kubernetes Secret mounted as env vars:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: paperclip-secrets
  namespace: paperclip
type: Opaque
stringData:
  ANTHROPIC_API_KEY: "sk-ant-..."
```

### Software Dependencies

- `@paperclipai/adapter-utils` >= 0.3.0 (peer dependency)
- Node.js 20+

## Installation

### Via Paperclip Adapter Manager

```bash
curl -X POST http://localhost:3100/api/adapters \
  -H "Content-Type: application/json" \
  -d '{"packageName": "paperclip-adapter-claude-k8s"}'
```

### Local Development

```bash
curl -X POST http://localhost:3100/api/adapters \
  -H "Content-Type: application/json" \
  -d '{"localPath": "/path/to/paperclip-adapter-claude-k8s"}'
```

## Configuration

Agent-level configuration fields set in `adapterConfig`:

### Core Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `model` | string | — | Claude model id (e.g., `claude-sonnet-4-6`) |
| `effort` | string | — | Reasoning effort: `low`, `medium`, or `high` |
| `maxTurnsPerRun` | number | 0 | Max turns per run (0 = unlimited) |
| `dangerouslySkipPermissions` | boolean | `true` | Skip permission prompts (required for unattended Jobs) |
| `instructionsFilePath` | string | — | Path to a markdown instructions file on the shared PVC |
| `extraArgs` | string[] | `[]` | Additional CLI args appended to the `claude` command |
| `env` | object | `{}` | Extra environment variables; overrides inherited Deployment vars |

### Kubernetes Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `namespace` | string | Deployment ns | Namespace for Job pods |
| `image` | string | Deployment image | Override container image |
| `imagePullPolicy` | string | `IfNotPresent` | Image pull policy |
| `kubeconfig` | string | — | Path to kubeconfig (defaults to in-cluster auth) |
| `serviceAccountName` | string | — | Service account for Job pods |
| `resources` | object | see below | CPU/memory requests and limits |
| `nodeSelector` | object | `{}` | Node selector for Job pods |
| `tolerations` | array | `[]` | Tolerations for Job pods |
| `labels` | object | `{}` | Extra labels on Job metadata |
| `ttlSecondsAfterFinished` | number | 300 | Auto-cleanup delay in seconds |
| `retainJobs` | boolean | `false` | Keep completed Jobs for debugging |

Default resource requests/limits:

```json
{
  "requests": { "cpu": "1000m", "memory": "2Gi" },
  "limits":   { "cpu": "4000m", "memory": "8Gi" }
}
```

### Operational Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `timeoutSec` | number | 0 | Run timeout in seconds (0 = no timeout) |
| `graceSec` | number | 60 | Grace period after Job deadline before the adapter gives up |

### Inherited from the Deployment (no config needed)

The adapter auto-discovers these from the running Paperclip pod:

- Container image and imagePullSecrets
- DNS configuration
- PVC claim name (mounted at `/paperclip`)
- Secret volumes
- Environment variables (`ANTHROPIC_API_KEY`, `PAPERCLIP_API_URL`, etc.)

## How It Works

1. **Self-introspection** — On first run, the adapter reads its own pod spec via the Kubernetes API to discover the container image, PVC claim, secrets, and environment variables.

2. **Concurrency guard** — Before creating a Job, the adapter checks for existing running Jobs for the same agent. Only one Job per agent is allowed at a time to prevent session conflicts on the shared PVC.

3. **Job creation** — A Kubernetes Job is created with:
   - A `busybox` init container that writes the prompt to an emptyDir volume
   - A main `claude` container that reads the prompt via stdin and runs Claude Code
   - The shared PVC mounted at `/paperclip` (with `HOME=/paperclip`)
   - All Paperclip environment variables forwarded
   - A non-root security context (UID/GID 1000)

4. **Log streaming** — The adapter follows the Job pod's logs in real time and forwards them to the Paperclip UI.

5. **Result parsing** — When the Job completes, Claude's stream-json output is parsed to extract session IDs, token usage, cost, and the result summary.

6. **Cleanup** — Completed Jobs are deleted automatically (unless `retainJobs` is set).

## License

MIT
