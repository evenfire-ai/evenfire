import { describe, it, expect } from "vitest";
import { serializeSessionKey, type SessionKey } from "../types";

describe("serializeSessionKey", () => {
  it("should serialize key with all fields", () => {
    const key: SessionKey = {
      userId: "alice",
      channelType: "telegram",
      channelId: "chat-123",
      threadId: "topic-42",
    };
    expect(serializeSessionKey(key)).toBe("alice:telegram:chat-123:topic-42");
  });

  it("should use 'default' when threadId is undefined", () => {
    const key: SessionKey = {
      userId: "alice",
      channelType: "telegram",
      channelId: "chat-123",
    };
    expect(serializeSessionKey(key)).toBe("alice:telegram:chat-123:default");
  });

  it("should produce different keys for different threads", () => {
    const key1: SessionKey = { userId: "alice", channelType: "slack", channelId: "C1", threadId: "t1" };
    const key2: SessionKey = { userId: "alice", channelType: "slack", channelId: "C1", threadId: "t2" };
    expect(serializeSessionKey(key1)).not.toBe(serializeSessionKey(key2));
  });

  it("should produce different keys for different channels", () => {
    const key1: SessionKey = { userId: "alice", channelType: "telegram", channelId: "chat-1" };
    const key2: SessionKey = { userId: "alice", channelType: "slack", channelId: "chat-1" };
    expect(serializeSessionKey(key1)).not.toBe(serializeSessionKey(key2));
  });

  it("should treat empty string threadId same as undefined", () => {
    const keyEmpty: SessionKey = { userId: "alice", channelType: "telegram", channelId: "chat-1", threadId: "" };
    const keyUndefined: SessionKey = { userId: "alice", channelType: "telegram", channelId: "chat-1" };
    expect(serializeSessionKey(keyEmpty)).toBe(serializeSessionKey(keyUndefined));
  });

  it("should use 'default' when channelId is empty or undefined", () => {
    const keyEmpty: SessionKey = { userId: "alice", channelType: "rpc", channelId: "" };
    const keyUndefined: SessionKey = { userId: "alice", channelType: "rpc", channelId: undefined as unknown as string };
    const keyDefault: SessionKey = { userId: "alice", channelType: "rpc", channelId: "default" };
    expect(serializeSessionKey(keyEmpty)).toBe(serializeSessionKey(keyDefault));
    expect(serializeSessionKey(keyUndefined)).toBe(serializeSessionKey(keyDefault));
  });
});
