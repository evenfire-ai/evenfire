/**
 * Kubernetes client for watching CommunicationChannel CRDs.
 */

import * as k8s from "@kubernetes/client-node";
import { CommunicationChannelCRD, CommunicationChannelSpec } from "./types";

const CRD_GROUP = "clerum.io";
const CRD_VERSION = "v1alpha1";
const CRD_PLURAL = "communicationchannels";

/** Delay before restarting the watch stream after a disconnect (ms). */
const WATCH_RECONNECT_DELAY_MS = 5000;

export type ChannelChangeCallback = (channels: CommunicationChannelCRD[]) => void;

export class CommunicationChannelWatcher {
  private api: k8s.CustomObjectsApi;
  private watch: k8s.Watch;
  private kc: k8s.KubeConfig;
  private hostRef: string;
  private namespace: string;
  private onChangeCallback?: ChannelChangeCallback;
  private channels: Map<string, CommunicationChannelCRD> = new Map();
  private watchRequest?: { abort: () => void };

  constructor(hostRef: string, namespace: string = "") {
    this.hostRef = hostRef;
    this.namespace = namespace;

    this.kc = new k8s.KubeConfig();

    // Try in-cluster config first, fall back to default kubeconfig
    try {
      this.kc.loadFromCluster();
      console.log("[K8s] Loaded in-cluster config");
    } catch {
      this.kc.loadFromDefault();
      console.log("[K8s] Loaded kubeconfig from default location");
    }

    this.api = this.kc.makeApiClient(k8s.CustomObjectsApi);
    this.watch = new k8s.Watch(this.kc);
  }

  /**
   * Set callback for when channels change.
   */
  onChange(callback: ChannelChangeCallback): void {
    this.onChangeCallback = callback;
  }

  /**
   * Get current channels matching hostRef.
   */
  getChannels(): CommunicationChannelCRD[] {
    return Array.from(this.channels.values());
  }

  /**
   * Initial list of CommunicationChannels.
   */
  public async listChannels(): Promise<CommunicationChannelCRD[]> {
    try {
      let response: { items?: unknown[] };

      if (this.namespace) {
        response = await this.api.listNamespacedCustomObject({
          group: CRD_GROUP,
          version: CRD_VERSION,
          namespace: this.namespace,
          plural: CRD_PLURAL,
        }) as { items?: unknown[] };
      } else {
        response = await this.api.listClusterCustomObject({
          group: CRD_GROUP,
          version: CRD_VERSION,
          plural: CRD_PLURAL,
        }) as { items?: unknown[] };
      }

      this.channels.clear();

      for (const item of response.items || []) {
        const channel = this.parseChannel(item as Record<string, unknown>);
        if (channel && channel.spec.hostRef === this.hostRef) {
          const key = `${channel.namespace}/${channel.name}`;
          this.channels.set(key, channel);
          console.log(`[K8s] Found channel: ${channel.name} (hostRef: ${channel.spec.hostRef})`);
        }
      }

      console.log(`[K8s] Found ${this.channels.size} CommunicationChannel(s) for hostRef "${this.hostRef}"`);
      return this.getChannels();
    } catch (error) {
      console.error("[K8s] Failed to list CommunicationChannels:", error);
      throw error;
    }
  }

  /**
   * Start watching for changes.
   */
  async startWatch(): Promise<void> {
    const path = this.namespace
      ? `/apis/${CRD_GROUP}/${CRD_VERSION}/namespaces/${this.namespace}/${CRD_PLURAL}`
      : `/apis/${CRD_GROUP}/${CRD_VERSION}/${CRD_PLURAL}`;

    console.log(`[K8s] Starting watch on ${path} for hostRef "${this.hostRef}"`);

    const watchHandler = async (type: string, apiObj: unknown) => {
      const channel = this.parseChannel(apiObj as Record<string, unknown>);
      if (!channel) return;

      const key = `${channel.namespace}/${channel.name}`;
      const matchesHost = channel.spec.hostRef === this.hostRef;

      let changed = false;

      switch (type) {
        case "ADDED":
        case "MODIFIED":
          if (matchesHost) {
            const existing = this.channels.get(key);
            if (!existing || JSON.stringify(existing) !== JSON.stringify(channel)) {
              this.channels.set(key, channel);
              changed = true;
              console.log(`[K8s] Channel ${type}: ${channel.name}`);
            }
          } else {
            // hostRef changed away from us
            if (this.channels.has(key)) {
              this.channels.delete(key);
              changed = true;
              console.log(`[K8s] Channel removed (hostRef changed): ${channel.name}`);
            }
          }
          break;

        case "DELETED":
          if (this.channels.has(key)) {
            this.channels.delete(key);
            changed = true;
            console.log(`[K8s] Channel DELETED: ${channel.name}`);
          }
          break;
      }

      if (changed && this.onChangeCallback) {
        this.onChangeCallback(this.getChannels());
      }
    };

    const startWatch = async () => {
      try {
        this.watchRequest = await this.watch.watch(
          path,
          {},
          watchHandler,
          (err) => {
            if (err) {
              console.error("[K8s] Watch error:", err);
            }
            // Restart watch after error or disconnect. Before restarting the
            // stream, re-list all CommunicationChannels so events that arrived
            // during the reconnect gap are not silently missed. If the
            // re-listed set differs from the in-memory cache, fire onChange so
            // the poll loop schedules a restart.
            console.log("[K8s] Watch ended, resyncing channels then restarting in 5s...");
            setTimeout(async () => {
              try {
                await this.resyncChannels();
                await startWatch();
              } catch (reconnectErr) {
                console.error("[K8s] Reconnect callback failed, scheduling another reconnect:", reconnectErr);
                setTimeout(() => startWatch(), WATCH_RECONNECT_DELAY_MS);
              }
            }, WATCH_RECONNECT_DELAY_MS);
          }
        );
      } catch (error) {
        console.error("[K8s] Failed to start watch:", error);
        setTimeout(() => startWatch(), WATCH_RECONNECT_DELAY_MS);
      }
    };

    await startWatch();
  }

  /**
   * Re-list all CommunicationChannels and reconcile the in-memory cache.
   * Fires onChange if the set changed. This is the entry point that triggers
   * the onChange callback on diff; listChannels() updates the cache but does
   * not fire onChange directly.
   * Called on watch reconnect and by the periodic reload timer so missed
   * events self-heal.
   */
  public async resyncChannels(): Promise<void> {
    const before = JSON.stringify(
      [...this.channels.entries()].sort(([a], [b]) => a.localeCompare(b))
    );

    try {
      await this.listChannels();
    } catch (err) {
      console.error("[K8s] Resync listChannels failed:", err);
      return;
    }

    const after = JSON.stringify(
      [...this.channels.entries()].sort(([a], [b]) => a.localeCompare(b))
    );

    if (before !== after && this.onChangeCallback) {
      console.log("[K8s] Channel set changed during resync, firing onChange");
      this.onChangeCallback(this.getChannels());
    }
  }

  /**
   * Stop watching.
   */
  stopWatch(): void {
    if (this.watchRequest) {
      this.watchRequest.abort();
      this.watchRequest = undefined;
    }
  }

  private parseChannel(item: Record<string, unknown>): CommunicationChannelCRD | null {
    try {
      const metadata = item.metadata as Record<string, unknown>;
      const spec = item.spec as CommunicationChannelSpec;

      if (!spec || !spec.hostRef) {
        return null;
      }

      return {
        name: (metadata?.name as string) || "",
        namespace: (metadata?.namespace as string) || "default",
        spec,
      };
    } catch (error) {
      console.warn("[K8s] Failed to parse CommunicationChannel:", error);
      return null;
    }
  }
}
