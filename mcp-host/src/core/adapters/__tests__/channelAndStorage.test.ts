import { describe, it, expect } from "vitest";
import { RpcChannelAdapter } from "../channelAdapter";
import { InMemoryStorage } from "../storageAdapter";
import { IncomingMessage, ConversationState } from "../../types";

describe("RpcChannelAdapter", () => {
  it("should yield pushed messages via receive()", async () => {
    const adapter = new RpcChannelAdapter();

    const msg: IncomingMessage = {
      id: "msg-1",
      channel: "telegram",
      user_id: "user-1",
      content: "Hello",
      metadata: {},
      received_at: new Date(),
    };

    adapter.pushMessage(msg);

    // Consume one message from the async iterable
    const iterator = adapter.receive()[Symbol.asyncIterator]();
    const result = await iterator.next();

    expect(result.done).toBe(false);
    expect(result.value).toBe(msg);
  });
});

describe("InMemoryStorage", () => {
  it("should save and load conversations", async () => {
    const storage = new InMemoryStorage();

    const conversation = {
      id: "conv-1",
      user_id: "user-1",
      state: ConversationState.Idle,
      turns: [],
      auto_approved_tools: new Set<string>(),
      created_at: new Date(),
      updated_at: new Date(),
    };

    await storage.saveConversation(conversation);
    const loaded = await storage.loadConversation("conv-1");

    expect(loaded).toBe(conversation);
  });

  it("should return null for unknown conversation", async () => {
    const storage = new InMemoryStorage();
    const loaded = await storage.loadConversation("nonexistent");

    expect(loaded).toBeNull();
  });
});
