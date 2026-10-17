import express from "express";
import { authorityBindingFromTrustedEdge } from "../runtime/actionAuthority";
import { getRuntimeCallerContext } from "./edgeRuntimeAuth";
import { json } from "./httpUtils";

declare function authenticateExternalUserSession(userId: string): void;

export function safeTrustedRpcEdge(req: any, res: any): void {
  const message = req.body;
  if (message.channelType === "rpc") {
    const caller = getRuntimeCallerContext(req);
    if (caller?.caller === "rpc-proxy" && caller.userId) {
      message.sender = caller.userId;
      const target = caller.actionContextV2.target;
      if (
        caller.actionContextV2.operationId !== "chat.message.invoke" ||
        !target ||
        target.messageId !== message.messageId ||
        target.channelType !== message.channelType ||
        target.channelId !== message.channelId
      ) {
        json(res, 403, { error: "mismatch" });
        return;
      }
      message.authorityV2 = authorityBindingFromTrustedEdge(
        caller.actionContextV2,
      );
    } else {
      json(res, 401, { error: "caller" });
      return;
    }
  }
}

export function unsafeWrongTargetOperator(req: any, res: any): void {
  const message = req.body;
  if (message.channelType === "rpc") {
    const caller = getRuntimeCallerContext(req);
    if (caller?.caller === "rpc-proxy" && caller.userId) {
      message.sender = caller.userId;
      const target = caller.actionContextV2.target;
      if (
        caller.actionContextV2.operationId !== "chat.message.invoke" ||
        !target ||
        target.messageId === message.messageId ||
        target.channelType !== message.channelType ||
        target.channelId !== message.channelId
      ) {
        json(res, 403, { error: "mismatch" });
        return;
      }
      message.authorityV2 = authorityBindingFromTrustedEdge(
        caller.actionContextV2,
      );
      authenticateExternalUserSession(message.sender);
    }
  }
}

export function unsafeCallerDisjunction(req: any, res: any): void {
  const message = req.body;
  if (message.channelType === "rpc") {
    const caller = getRuntimeCallerContext(req);
    if (caller?.caller === "rpc-proxy" || caller.userId) {
      message.sender = caller.userId;
      const target = caller.actionContextV2.target;
      if (
        caller.actionContextV2.operationId !== "chat.message.invoke" ||
        !target ||
        target.messageId !== message.messageId ||
        target.channelType !== message.channelType ||
        target.channelId !== message.channelId
      ) {
        json(res, 403, { error: "mismatch" });
        return;
      }
      message.authorityV2 = authorityBindingFromTrustedEdge(
        caller.actionContextV2,
      );
      authenticateExternalUserSession(message.sender);
    }
  }
}

export function unsafeMismatchConjunction(req: any, res: any): void {
  const message = req.body;
  if (message.channelType === "rpc") {
    const caller = getRuntimeCallerContext(req);
    if (caller?.caller === "rpc-proxy" && caller.userId) {
      message.sender = caller.userId;
      const target = caller.actionContextV2.target;
      if (
        caller.actionContextV2.operationId !== "chat.message.invoke" ||
        !target ||
        (target.messageId !== message.messageId &&
          target.channelType !== message.channelType) ||
        target.channelId !== message.channelId
      ) {
        json(res, 403, { error: "mismatch" });
        return;
      }
      message.authorityV2 = authorityBindingFromTrustedEdge(
        caller.actionContextV2,
      );
      authenticateExternalUserSession(message.sender);
    }
  }
}

export function unsafeUserSender(req: any, res: any): void {
  const message = req.body;
  if (message.channelType === "rpc") {
    const caller = getRuntimeCallerContext(req);
    if (caller?.caller === "rpc-proxy" && caller.userId) {
      if (caller.actionContextV2.operationId !== "chat.message.invoke") {
        json(res, 403, { error: "mismatch" });
        return;
      }
      message.authorityV2 = authorityBindingFromTrustedEdge(
        caller.actionContextV2,
      );
      authenticateExternalUserSession(message.sender);
    }
  }
}

export function unsafeMissingCaller(req: any, res: any): void {
  const message = req.body;
  if (message.channelType === "rpc") {
    const caller = getRuntimeCallerContext(req);
    message.sender = caller.userId;
    if (
      caller.actionContextV2.operationId !== "chat.message.invoke" ||
      caller.actionContextV2.target.messageId !== message.messageId ||
      caller.actionContextV2.target.channelType !== message.channelType ||
      caller.actionContextV2.target.channelId !== message.channelId
    ) {
      json(res, 403, { error: "mismatch" });
      return;
    }
    message.authorityV2 = authorityBindingFromTrustedEdge(
      caller.actionContextV2,
    );
    authenticateExternalUserSession(message.sender);
  }
}

export function unsafeMissingTarget(req: any, res: any): void {
  const message = req.body;
  if (message.channelType === "rpc") {
    const caller = getRuntimeCallerContext(req);
    if (caller?.caller === "rpc-proxy" && caller.userId) {
      message.sender = caller.userId;
      if (caller.actionContextV2.operationId !== "chat.message.invoke") {
        json(res, 403, { error: "mismatch" });
        return;
      }
      message.authorityV2 = authorityBindingFromTrustedEdge(
        caller.actionContextV2,
      );
      authenticateExternalUserSession(message.sender);
    }
  }
}

const router = express.Router();
router.post("/safe", safeTrustedRpcEdge);
router.post("/unsafe-sender", unsafeUserSender);
router.post("/unsafe-caller", unsafeMissingCaller);
router.post("/unsafe-target", unsafeMissingTarget);
router.post("/unsafe-target-operator", unsafeWrongTargetOperator);
router.post("/unsafe-caller-disjunction", unsafeCallerDisjunction);
router.post("/unsafe-mismatch-conjunction", unsafeMismatchConjunction);
