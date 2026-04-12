import * as k8s from "@kubernetes/client-node";
import { readFileSync } from "node:fs";

/**
 * Cached self-pod introspection result. Queried once on first execute(),
 * then reused for all subsequent Job builds so every Job inherits the
 * Deployment's image, imagePullSecrets, DNS config, and PVC claim.
 */
export interface SelfPodSecretVolume {
  volumeName: string;
  secretName: string;
  mountPath: string;
  defaultMode: number | undefined;
}

export interface SelfPodInfo {
  namespace: string;
  image: string;
  imagePullSecrets: Array<{ name: string }>;
  dnsConfig: k8s.V1PodDNSConfig | undefined;
  pvcClaimName: string | null;
  secretVolumes: SelfPodSecretVolume[];
  /** Env vars inherited from the Deployment container. */
  inheritedEnv: Record<string, string>;
}

let cachedSelfPod: SelfPodInfo | null = null;

/**
 * Cache keyed by kubeconfig path (empty string = in-cluster).
 * Supports multiple agents with different kubeconfigs.
 */
const kcCache = new Map<string, k8s.KubeConfig>();

function getKubeConfig(kubeconfigPath?: string): k8s.KubeConfig {
  const key = kubeconfigPath ?? "";
  let kc = kcCache.get(key);
  if (!kc) {
    kc = new k8s.KubeConfig();
    if (kubeconfigPath) {
      kc.loadFromFile(kubeconfigPath);
    } else {
      kc.loadFromCluster();
    }
    kcCache.set(key, kc);
  }
  return kc;
}

export function getBatchApi(kubeconfigPath?: string): k8s.BatchV1Api {
  return getKubeConfig(kubeconfigPath).makeApiClient(k8s.BatchV1Api);
}

export function getCoreApi(kubeconfigPath?: string): k8s.CoreV1Api {
  return getKubeConfig(kubeconfigPath).makeApiClient(k8s.CoreV1Api);
}

export function getAuthzApi(kubeconfigPath?: string): k8s.AuthorizationV1Api {
  return getKubeConfig(kubeconfigPath).makeApiClient(k8s.AuthorizationV1Api);
}

export function getLogApi(kubeconfigPath?: string): k8s.Log {
  return new k8s.Log(getKubeConfig(kubeconfigPath));
}

/**
 * Read the current pod's namespace. Checks (in order):
 * 1. PAPERCLIP_NAMESPACE env var (set explicitly in Deployment)
 * 2. Service account namespace file (standard in-cluster path)
 * 3. POD_NAMESPACE env var (Downward API convention)
 * Falls back to "default" only if none of the above are available.
 */
function readInClusterNamespace(): string {
  const fromEnv = process.env.PAPERCLIP_NAMESPACE ?? process.env.POD_NAMESPACE;
  if (fromEnv?.trim()) return fromEnv.trim();
  try {
    return readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/namespace", "utf-8").trim();
  } catch {
    return "default";
  }
}

/**
 * Query the K8s API for our own pod spec and cache the result.
 * Extracts image, imagePullSecrets, dnsConfig, PVC claim name,
 * and environment variables to forward to Job pods.
 */
export async function getSelfPodInfo(kubeconfigPath?: string): Promise<SelfPodInfo> {
  if (cachedSelfPod) return cachedSelfPod;

  const hostname = process.env.HOSTNAME;
  if (!hostname) {
    throw new Error("claude_k8s: HOSTNAME env var not set — cannot introspect running pod");
  }

  const namespace = readInClusterNamespace();
  const coreApi = getCoreApi(kubeconfigPath);
  const pod = await coreApi.readNamespacedPod({ name: hostname, namespace });

  const spec = pod.spec;
  if (!spec) {
    throw new Error(`claude_k8s: pod ${hostname} has no spec`);
  }

  const mainContainer = spec.containers[0];
  if (!mainContainer?.image) {
    throw new Error(`claude_k8s: pod ${hostname} has no container image`);
  }

  // Find PVC claim name from volumes mounted at /paperclip
  let pvcClaimName: string | null = null;
  const dataMount = mainContainer.volumeMounts?.find(
    (vm) => vm.mountPath === "/paperclip",
  );
  if (dataMount) {
    const volume = spec.volumes?.find((v) => v.name === dataMount.name);
    pvcClaimName = volume?.persistentVolumeClaim?.claimName ?? null;
  }

  // Discover secret volumes mounted on the main container
  const secretVolumes: SelfPodSecretVolume[] = [];
  for (const vm of mainContainer.volumeMounts ?? []) {
    const vol = spec.volumes?.find((v) => v.name === vm.name);
    if (vol?.secret?.secretName) {
      secretVolumes.push({
        volumeName: vm.name,
        secretName: vol.secret.secretName,
        mountPath: vm.mountPath,
        defaultMode: vol.secret.defaultMode,
      });
    }
  }

  // Collect env vars from the pod spec's container definition.
  // Agent config env (set in buildEnvVars) will override these.
  const inheritedEnv: Record<string, string> = {};
  for (const envItem of mainContainer.env ?? []) {
    if (!envItem.name) continue;
    const value = envItem.value ?? "";
    if (value) inheritedEnv[envItem.name] = value;
  }

  cachedSelfPod = {
    namespace,
    image: mainContainer.image,
    imagePullSecrets: (spec.imagePullSecrets ?? []).map((s) => ({
      name: s.name ?? "",
    })).filter((s) => s.name.length > 0),
    dnsConfig: spec.dnsConfig,
    pvcClaimName,
    secretVolumes,
    inheritedEnv,
  };

  return cachedSelfPod;
}

/** Reset cached state — useful for tests. */
export function resetCache(): void {
  kcCache.clear();
  cachedSelfPod = null;
}
