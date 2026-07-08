import { Channel } from "../interfaces";
import { IncomingMessage, OutgoingResponse, StatusUpdate } from "../types";

/**
 * Adapts the existing HTTP RPC interface to the spec's Channel interface.
 *
 * In Clerum, channel-reader is a separate K8s service that POSTs to
 * mcp-host's /message endpoint. This adapter bridges the gap:
 *
 * - receive(): yields messages from an internal queue (fed by server.ts)
 * - respond(): invokes the Task's responseCallback
 * - sendStatus(): logs status (no channel forwarding yet)
 */
export class RpcChannelAdapter implements Channel {
  private messageQueue: IncomingMessage[] = [];
  private resolvers: ((msg: IncomingMessage) => void)[] = [];

  /**
   * Push a message into the adapter (called by server.ts when
   * /message endpoint receives a request).
   */
  pushMessage(msg: IncomingMessage): void {
    if (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift()!;
      resolver(msg);
    } else {
      this.messageQueue.push(msg);
    }
  }

  /**
   * Yields incoming messages as an async iterable.
   * Blocks until a message is available.
   */
  async *receive(): AsyncIterable<IncomingMessage> {
    while (true) {
      if (this.messageQueue.length > 0) {
        yield this.messageQueue.shift()!;
      } else {
        yield new Promise<IncomingMessage>((resolve) => {
          this.resolvers.push(resolve);
        });
      }
    }
  }

  /**
   * Send response back through the channel.
   * In Clerum, this is handled by the Task's responseCallback
   * which was set when the message was enqueued.
   * The actual response routing happens in the Agent Core.
   */
  async respond(
    _original: IncomingMessage,
    _response: OutgoingResponse,
  ): Promise<void> {
    // Handled by Task.responseCallback in AgentStateMachine.
    // This method is a spec-compliance placeholder.
    // The actual response path is:
    //   AgentStateMachine → task.responseCallback → server.ts → HTTP response → channel-reader
  }

  sendStatus(status: StatusUpdate): void {
    console.log(
      `[Channel] Status: ${status.type}${status.detail ? ` - ${status.detail}` : ""}`,
    );
  }
}
