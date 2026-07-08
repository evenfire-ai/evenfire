import * as k8s from "@kubernetes/client-node";
import { describe, expect, it, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const runK8sIntegration = process.env.CONTROL_API_K8S_INTEGRATION === "true";
const describeK8s = runK8sIntegration ? describe : describe.skip;

describeK8s("integration/k8s network boundary validation", () => {
  beforeAll(() => {
    // Self-bootstrap: apply required NetworkPolicy manifests so the test
    // does not depend on a manual pre-deployment step.
    const deployDir = resolve(__dirname, "..", "deploy");
    const hccDeployDir = resolve(__dirname, "..", "..", "host-context-controller", "deploy");
    execSync(`kubectl apply -f ${deployDir}/networkpolicy.yaml`, { stdio: "pipe" });
    execSync(`kubectl apply -f ${hccDeployDir}/networkpolicy.yaml`, { stdio: "pipe" });
  });

  it("applies expected gateway network policies in cluster", async () => {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const networking = kc.makeApiClient(k8s.NetworkingV1Api);

    const controlGatewayPolicy = await networking.readNamespacedNetworkPolicy({
      namespace: "control-plane",
      name: "control-api-rpc-gateway"
    });
    expect(controlGatewayPolicy.spec?.podSelector?.matchLabels?.app).toBe("control-api-rpc-gateway");
    expect(controlGatewayPolicy.spec?.ingress?.length || 0).toBeGreaterThan(0);
    expect(controlGatewayPolicy.spec?.egress?.length || 0).toBeGreaterThan(0);

    const hccGatewayPolicy = await networking.readNamespacedNetworkPolicy({
      namespace: "control-plane",
      name: "host-context-controller-api-gateway"
    });
    expect(hccGatewayPolicy.spec?.podSelector?.matchLabels?.app).toBe("host-context-controller-api-gateway");
    expect(hccGatewayPolicy.spec?.ingress?.length || 0).toBeGreaterThan(0);
  });

  it("keeps direct host-context-controller ingress locked to gateway", async () => {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const networking = kc.makeApiClient(k8s.NetworkingV1Api);

    const directPolicy = await networking.readNamespacedNetworkPolicy({
      namespace: "control-plane",
      name: "host-context-controller-api-direct"
    });

    const ingress = directPolicy.spec?.ingress || [];
    expect(ingress.length).toBeGreaterThan(0);

    // @kubernetes/client-node serializes "from" as "_from" because "from" is
    // a JS reserved word. Access the raw property to read ingress sources.
    const rawIngress = ingress[0] as Record<string, unknown>;
    const fromEntries = ((rawIngress._from ?? rawIngress.from) || []) as Array<{
      namespaceSelector?: { matchLabels?: Record<string, string> };
      podSelector?: { matchLabels?: Record<string, string> };
    }>;
    expect(fromEntries.length).toBeGreaterThan(0);

    const hasGatewaySource = fromEntries.some(
      (entry) =>
        entry.namespaceSelector?.matchLabels?.["kubernetes.io/metadata.name"] === "control-plane" &&
        entry.podSelector?.matchLabels?.app === "host-context-controller-api-gateway"
    );
    expect(hasGatewaySource).toBe(true);
  });
});

