import express from "express";
import {
  extractAuthToken,
  requireRpcAuth,
  requireScope,
} from "../middleware/auth";
import { verifySandboxUiSession } from "../services/sandboxUiSession";
import { tokenDeclaresV2 } from "../userDelegationV2";

function isV2ViewRequest(req: any): boolean {
  return Boolean(req.userDelegationV2 && req.authorizedActionV2);
}

function v2ViewAuthority(req: any, res: any, next: () => void): void {
  if (!tokenDeclaresV2(extractAuthToken(req))) {
    next();
    return;
  }
  requireRpcAuth(req, res, () =>
    requireScope("sandbox:ui:view")(req, res, next),
  );
}

function unsafeV2ViewAuthorityPostAuth(
  req: any,
  res: any,
  next: () => void,
): void {
  if (!tokenDeclaresV2(extractAuthToken(req))) {
    next();
    return;
  }
  requireRpcAuth(req, res, () =>
    requireScope("sandbox:ui:view")(req, res, next),
  );
  next();
}

const router = express.Router();

router.all("/safe-view/*", v2ViewAuthority, (req: any, res: any) => {
  const v2Request = isV2ViewRequest(req);
  const legacyCookie = req.cookies.sandboxUiCookieName;
  const legacyClaims =
    v2Request || !legacyCookie ? null : verifySandboxUiSession(legacyCookie);
  if (!v2Request && !legacyCookie) {
    res.status(401).json({ error: "required" });
    return;
  }
  if (!v2Request && !legacyClaims) {
    res.status(401).json({ error: "invalid" });
    return;
  }
  res.json({ userId: v2Request ? req.auth.sub : legacyClaims.sub });
});

router.all("/unsafe-no-middleware/*", (req: any, res: any) => {
  const v2Request = isV2ViewRequest(req);
  const legacyCookie = req.cookies.sandboxUiCookieName;
  const legacyClaims =
    v2Request || !legacyCookie ? null : verifySandboxUiSession(legacyCookie);
  if (!v2Request && !legacyClaims) {
    res.status(401).json({ error: "invalid" });
    return;
  }
  res.json({ userId: v2Request ? req.auth.sub : legacyClaims.sub });
});

router.all("/unsafe-fallback/*", v2ViewAuthority, (req: any, res: any) => {
  const v2Request = isV2ViewRequest(req);
  const legacyCookie = req.cookies.sandboxUiCookieName;
  const legacyClaims = !legacyCookie
    ? null
    : verifySandboxUiSession(legacyCookie);
  if (!v2Request && !legacyClaims) {
    res.status(401).json({ error: "invalid" });
    return;
  }
  res.json({ userId: v2Request ? req.auth.sub : legacyClaims.sub });
});

router.all(
  "/unsafe-post-auth-dispatch/*",
  unsafeV2ViewAuthorityPostAuth,
  (req: any, res: any) => {
    const v2Request = isV2ViewRequest(req);
    const legacyCookie = req.cookies.sandboxUiCookieName;
    const legacyClaims =
      v2Request || !legacyCookie ? null : verifySandboxUiSession(legacyCookie);
    if (!v2Request && !legacyClaims) {
      res.status(401).json({ error: "invalid" });
      return;
    }
    res.json({ userId: v2Request ? req.auth.sub : legacyClaims.sub });
  },
);

router.all("/unsafe-body-v2-state/*", v2ViewAuthority, (req: any, res: any) => {
  const v2Request = Boolean(req.body.v2Request);
  const legacyCookie = req.cookies.sandboxUiCookieName;
  const legacyClaims =
    v2Request || !legacyCookie ? null : verifySandboxUiSession(legacyCookie);
  if (!v2Request && !legacyClaims) {
    res.status(401).json({ error: "invalid" });
    return;
  }
  res.json({ userId: v2Request ? req.auth.sub : legacyClaims.sub });
});

router.all(
  "/unsafe-shadowed-classifier/*",
  v2ViewAuthority,
  (req: any, res: any) => {
    const isV2ViewRequest = (candidate: any): boolean =>
      Boolean(candidate.body.v2Request);
    const v2Request = isV2ViewRequest(req);
    const legacyCookie = req.cookies.sandboxUiCookieName;
    const legacyClaims =
      v2Request || !legacyCookie ? null : verifySandboxUiSession(legacyCookie);
    if (!v2Request && !legacyClaims) {
      res.status(401).json({ error: "invalid" });
      return;
    }
    res.json({ userId: v2Request ? req.auth.sub : legacyClaims.sub });
  },
);

router.all(
  "/unsafe-early-classifier-return/*",
  v2ViewAuthority,
  (req: any, res: any) => {
    function isV2ViewRequest(candidate: any): boolean {
      if (candidate.body.v2Request) return true;
      return Boolean(
        candidate.userDelegationV2 && candidate.authorizedActionV2,
      );
    }
    const v2Request = isV2ViewRequest(req);
    const legacyCookie = req.cookies.sandboxUiCookieName;
    const legacyClaims =
      v2Request || !legacyCookie ? null : verifySandboxUiSession(legacyCookie);
    if (!v2Request && !legacyClaims) {
      res.status(401).json({ error: "invalid" });
      return;
    }
    res.json({ userId: v2Request ? req.auth.sub : legacyClaims.sub });
  },
);

export default router;
