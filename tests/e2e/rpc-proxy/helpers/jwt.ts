import { generateKeyPairSync } from "node:crypto";
import jwt from "jsonwebtoken";

export const TEST_JWT_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCsIhgYd6Ew+kYp
4/FopBqsNfnKvOJ9TmLh/OkjcS2QpJTqzm6DsSQrFzYN0x6Sipd72+vuorJXCKKV
Qi6xcteJbso8wmUP8V3kGjtDG3r3BiIvkjgrft4OAI3oPct24fJISeSF0jQYOkHg
szYBI7FCQRpt6l6RlMxDITGYIif90cnXkH7gD22KJ6mFg5A2vcZydb14OiYy3o0k
vKmKRuvEk7o7sCvQb6tpNt+W2HwRDNacYX5aBBbiKIzfCwWGloTSZSURswYMZMwB
nLUp/EBFG75Bmbcuj7kCIJoeSKMMKCUexcuGqxiLYB1GJq8PUaT0so//O0rDur8P
p9gXOY5DAgMBAAECggEAVAGPoOFBWZXLCEamWls8aS8uaTMlleHbgE7duN5TTnQD
+VQluz+IVz9MshKGqR3aMCh0TFI6lx8vuYhDIXbamcfoCx8UE2PIXroukeGncUcd
B/pkT1XrKQo8N0txMOO0SnNFg8nCgtBrti2//W5d4+fB7kKjRIlJ5rkcaxLAUa5z
fpvaz+DhwBvvIi5zakhUBGVinVnQV6cKS5c52ccYikSNG9ysGBParCbVsQCwgLan
JhWCmRYuPj5MoaELcZ7lBO2ow+SO/VSTW03fnC/cIYCxZqAEEnq3fg5/FFsy6xsB
CbwQQaGnUrrw/LyGX3vyW7eXDL4hOYLp+l+tZklqAQKBgQDe8I4RegQ7lGvVnEoo
xTBdZg6kgjSRRBMs67/E+HrnnHC8gMjT2MlJguYQEonFP8teDoj0l7+1Bj/LRyHv
CyZr03EpevMQut27VdEO/qWYaGpOsXC2xkuiJWeKYvp3//lcIofXy9VhStlsisk6
yx1LAY6iiZvptaCzJmYTU677swKBgQDFqMaLyLAAIpMcBrLDlGt8qyB6ZVaJZTHP
vs13Md6RJPVXXyGtWRtpMwOSwHJNyy3xN23rWtlj32UE9KW/47oxjbkXfpExG/fi
UBeA80AtjM57q66+LZ9Rs5EAFcOsNrd11XY4Y/37/MMbWQgjfW44uEeB2drx9mB0
LU9H+1KbMQKBgFKij8Zil9cNuLrA56wdC0RTY/IOYTXHKeRorfhwsf3PuunkQoxj
upiI8IXcmTyH3PXMJW+kH+cVnefXQfi9BUzKXxOlAxucaDvcH1WThgXsDhuFIeZd
sgM0IiDldzmro95G3ltarokVmWnmN5iXWRBIT3pnz2bdb+d3wDZBuoaJAoGABCl9
pMvhCN+xgVGSyhOB/+oKkQk5PUNoPRujb/MY4K2KjQBv0RqjPR/Z32k1/vVcTkwA
gIg1M6ksk2Ija1r8PLbjQt9jZ0lTeux80jZND6h7YJdI4rBLPoktcHcE28d7LXwF
NULFwlycLyM8zKKDg6Y9uzo/JgEuHsQlezqLjsECgYAboHrpwXg/SBatigtBvj0E
1ccXGGLgN2dhDbAlZoSKDITOxGiOw48bOX1lT25c06muru+2mCNrsN2lMs07VGk8
PSRsIuFZis/4vrRtjoxUB4OQ29+mfVgqGsABPugCmi/r22gWrvl1aqEEqstg3m7x
sKRpFxViv5P5TmnxLggnhw==
-----END PRIVATE KEY-----`;

export const TEST_JWT_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArCIYGHehMPpGKePxaKQa
rDX5yrzifU5i4fzpI3EtkKSU6s5ug7EkKxc2DdMekoqXe9vr7qKyVwiilUIusXLX
iW7KPMJlD/Fd5Bo7Qxt69wYiL5I4K37eDgCN6D3LduHySEnkhdI0GDpB4LM2ASOx
QkEabepekZTMQyExmCIn/dHJ15B+4A9tiiephYOQNr3GcnW9eDomMt6NJLypikbr
xJO6O7Ar0G+raTbflth8EQzWnGF+WgQW4iiM3wsFhpaE0mUlEbMGDGTMAZy1KfxA
RRu+QZm3Lo+5AiCaHkijDCglHsXLhqsYi2AdRiavD1Gk9LKP/ztKw7q/D6fYFzmO
QwIDAQAB
-----END PUBLIC KEY-----`;

type RpcJwtOptions = {
  sub?: string;
  typ?: "user" | "service";
  teamId?: string;
  scopes?: string[];
  hostRefs?: string[];
  iss?: string;
  aud?: string;
  expiresInSeconds?: number;
  now?: number;
  privateKey?: string;
  jti?: string;
};

export function signRpcJwt(opts: RpcJwtOptions = {}): string {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const exp = now + (opts.expiresInSeconds ?? 300);
  return jwt.sign(
    {
      sub: opts.sub ?? "e2e-user",
      typ: opts.typ ?? "user",
      teamId: opts.teamId ?? "e2e-team",
      scopes: opts.scopes ?? ["mcp:servers:list", "mcp:server:invoke"],
      hostRefs: opts.hostRefs ?? ["agent2"],
      jti: opts.jti ?? `e2e-${now}`,
      iat: now,
      exp
    },
    opts.privateKey ?? TEST_JWT_PRIVATE_KEY,
    {
      algorithm: "RS256",
      issuer: opts.iss ?? "control-api",
      audience: opts.aud ?? "rpc-proxy"
    }
  );
}

export function signWithWrongKey(opts: Omit<RpcJwtOptions, "privateKey"> = {}): string {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" }
  });
  return signRpcJwt({ ...opts, privateKey });
}
