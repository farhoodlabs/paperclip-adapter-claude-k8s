import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { getSelfPodInfo, getCoreApi, getAuthzApi } from "./k8s-client.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

async function checkApiReachable(checks: AdapterEnvironmentCheck[], kubeconfigPath?: string): Promise<boolean> {
  try {
    const selfPod = await getSelfPodInfo(kubeconfigPath);
    checks.push({
      code: "k8s_api_reachable",
      level: "info",
      message: `Kubernetes API reachable; running in namespace ${selfPod.namespace}`,
      detail: `Image: ${selfPod.image}`,
    });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({
      code: "k8s_api_unreachable",
      level: "error",
      message: `Cannot reach Kubernetes API: ${msg}`,
      hint: "Ensure the pod has a valid service account token mounted and the API server is accessible.",
    });
    return false;
  }
}

async function checkNamespace(
  namespace: string,
  selfPodNamespace: string,
  checks: AdapterEnvironmentCheck[],
  kubeconfigPath?: string,
): Promise<boolean> {
  // If targeting the same namespace we're running in, skip the cluster-scoped
  // readNamespace call — we know it exists, and the SA may lack cluster-level
  // namespace get permissions.
  if (namespace === selfPodNamespace) {
    checks.push({
      code: "k8s_namespace_exists",
      level: "info",
      message: `Target namespace is the pod namespace: ${namespace}`,
    });
    return true;
  }

  try {
    const coreApi = getCoreApi(kubeconfigPath);
    await coreApi.readNamespace({ name: namespace });
    checks.push({
      code: "k8s_namespace_exists",
      level: "info",
      message: `Target namespace exists: ${namespace}`,
    });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({
      code: "k8s_namespace_check_failed",
      level: "warn",
      message: `Cannot verify namespace "${namespace}": ${msg}`,
      hint: "The service account may lack cluster-level namespace read permissions. The namespace may still be usable — verify RBAC checks below.",
    });
    // Don't block on this — RBAC checks below will catch actual permission issues
    return true;
  }
}

async function checkRbac(
  namespace: string,
  checks: AdapterEnvironmentCheck[],
  kubeconfigPath?: string,
): Promise<void> {
  const authzApi = getAuthzApi(kubeconfigPath);

  const rbacChecks = [
    { resource: "jobs", group: "batch", verb: "create", code: "k8s_rbac_job_create", label: "create Jobs" },
    { resource: "jobs", group: "batch", verb: "delete", code: "k8s_rbac_job_delete", label: "delete Jobs" },
    { resource: "jobs", group: "batch", verb: "get", code: "k8s_rbac_job_get", label: "get Jobs" },
    { resource: "jobs", group: "batch", verb: "list", code: "k8s_rbac_job_list", label: "list Jobs" },
    { resource: "pods", group: "", verb: "list", code: "k8s_rbac_pod_list", label: "list Pods" },
    { resource: "pods/log", group: "", verb: "get", code: "k8s_rbac_pod_log", label: "get Pod logs" },
    { resource: "secrets", group: "", verb: "create", code: "k8s_rbac_secret_create", label: "create Secrets" },
    { resource: "secrets", group: "", verb: "delete", code: "k8s_rbac_secret_delete", label: "delete Secrets" },
    { resource: "secrets", group: "", verb: "get", code: "k8s_rbac_secret_get", label: "get Secrets" },
    { resource: "persistentvolumeclaims", group: "", verb: "get", code: "k8s_rbac_pvc_get", label: "get PersistentVolumeClaims" },
  ];

  for (const check of rbacChecks) {
    try {
      const review = await authzApi.createSelfSubjectAccessReview({
        body: {
          apiVersion: "authorization.k8s.io/v1",
          kind: "SelfSubjectAccessReview",
          spec: {
            resourceAttributes: {
              namespace,
              verb: check.verb,
              resource: check.resource,
              group: check.group,
            },
          },
        },
      });
      if (review.status?.allowed) {
        checks.push({
          code: check.code,
          level: "info",
          message: `RBAC: allowed to ${check.label} in ${namespace}`,
        });
      } else {
        checks.push({
          code: check.code,
          level: "error",
          message: `RBAC: not allowed to ${check.label} in ${namespace}`,
          hint: `Grant the service account permission to ${check.verb} ${check.resource} in namespace ${namespace}.`,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      checks.push({
        code: check.code,
        level: "warn",
        message: `RBAC check failed for ${check.label}: ${msg}`,
        hint: "SelfSubjectAccessReview may not be available; verify permissions manually.",
      });
    }
  }
}

async function checkSecret(
  namespace: string,
  secretName: string,
  checks: AdapterEnvironmentCheck[],
  kubeconfigPath?: string,
): Promise<void> {
  try {
    const coreApi = getCoreApi(kubeconfigPath);
    await coreApi.readNamespacedSecret({ name: secretName, namespace });
    checks.push({
      code: "k8s_secret_exists",
      level: "info",
      message: `Secret "${secretName}" exists in namespace ${namespace}`,
    });
  } catch {
    checks.push({
      code: "k8s_secret_missing",
      level: "warn",
      message: `Secret "${secretName}" not found in namespace ${namespace}`,
      hint: `Ensure the paperclip-secrets Secret exists with keys for ANTHROPIC_API_KEY and/or AWS_BEARER_TOKEN_BEDROCK.`,
    });
  }
}

async function checkPvc(
  selfPod: { pvcClaimName: string | null; namespace: string },
  checks: AdapterEnvironmentCheck[],
  kubeconfigPath?: string,
): Promise<void> {
  if (!selfPod.pvcClaimName) {
    checks.push({
      code: "k8s_pvc_not_detected",
      level: "warn",
      message: "No PVC detected on /paperclip mount — session resume and workspace sharing will not work.",
      hint: "Ensure the Paperclip Deployment has a PVC mounted at /paperclip with ReadWriteMany access mode.",
    });
    return;
  }

  try {
    const coreApi = getCoreApi(kubeconfigPath);
    const pvc = await coreApi.readNamespacedPersistentVolumeClaim({
      name: selfPod.pvcClaimName,
      namespace: selfPod.namespace,
    });
    const accessModes = pvc.spec?.accessModes ?? [];
    const isRwx = accessModes.includes("ReadWriteMany");
    if (isRwx) {
      checks.push({
        code: "k8s_pvc_rwx",
        level: "info",
        message: `PVC "${selfPod.pvcClaimName}" has ReadWriteMany access — Job pods can mount it.`,
      });
    } else {
      checks.push({
        code: "k8s_pvc_not_rwx",
        level: "warn",
        message: `PVC "${selfPod.pvcClaimName}" access modes: ${accessModes.join(", ")}. ReadWriteMany is required for Job pods to share the volume.`,
        hint: "Change the PVC accessMode to ReadWriteMany in Helm values.",
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({
      code: "k8s_pvc_check_failed",
      level: "warn",
      message: `Could not read PVC "${selfPod.pvcClaimName}": ${msg}`,
    });
  }
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const secretRef = asString(config.secretRef, "paperclip-secrets");
  const kubeconfigPath = asString(config.kubeconfig, "") || undefined;

  // 1. K8s API reachable + self-pod introspection
  const apiOk = await checkApiReachable(checks, kubeconfigPath);
  if (!apiOk) {
    return { adapterType: ctx.adapterType, status: summarizeStatus(checks), checks, testedAt: new Date().toISOString() };
  }

  const selfPod = await getSelfPodInfo(kubeconfigPath);
  const namespace = asString(config.namespace, "") || selfPod.namespace;

  // 2. Target namespace exists
  const nsOk = await checkNamespace(namespace, selfPod.namespace, checks, kubeconfigPath);

  // 3-5. Run remaining checks even if namespace check failed so operators see
  // all issues at once instead of fixing them one at a time.
  if (nsOk) {
    await Promise.all([
      checkRbac(namespace, checks, kubeconfigPath),
      checkSecret(namespace, secretRef, checks, kubeconfigPath),
      checkPvc(selfPod, checks, kubeconfigPath),
    ]);
  } else {
    await checkRbac(namespace, checks, kubeconfigPath);
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
