# paperclip-adapter-claude-k8s

Paperclip adapter plugin that runs Claude Code agents as isolated Kubernetes Jobs instead of inside the main Paperclip process.

## Features

- Spawns agent runs as K8s Jobs with full pod isolation
- Inherits container image, secrets, DNS, and PVC from the Paperclip Deployment automatically
- Real-time log streaming from Job pods back to the Paperclip UI
- Session resume via shared RWX PVC
- Per-agent concurrency guard
- Configurable resources, namespace, kubeconfig
- Bedrock model support

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
  -d '{"localPath": "/path/to/paperclip-claude-k8s"}'
```

## Configuration

See the agent configuration documentation for all available fields:

- `namespace` — K8s namespace for Jobs (defaults to Deployment namespace)
- `image` — Override container image
- `kubeconfig` — Path to kubeconfig file
- `resources` — CPU/memory requests and limits
- `timeoutSec` — Run timeout (0 = no timeout)
- `retainJobs` — Keep completed Jobs for debugging

## Requirements

- Kubernetes cluster with RBAC permissions to create Jobs, list Pods, and read Pod logs
- **Paperclip must be deployed on a RWX PVC** mounted at `/paperclip` — this shared volume is required for session resume and workspace access
- `@paperclipai/adapter-utils` >= 0.3.0

## License

MIT
