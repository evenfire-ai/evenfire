import { describe, expect, it, vi } from "vitest";
import { mintHostGfsToken } from "./gfsHostBinding";

/**
 * P3-S02 — HCC 1st-party host gfs token mint. Every Host shares the sentinel
 * binding mcp-host/standalone; read-only scope in P3; fail-loud on error.
 */

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

describe("mintHostGfsToken", () => {
  it("POSTs to the sentinel provisioner route with the InternalControl bearer and read scope", async () => {
    const fetchFn = vi.fn(async () =>
      okResponse({ token: "tok", expiresInSeconds: 300, subject: "host:1st:mcp-host/standalone" })
    ) as unknown as typeof fetch;
    const out = await mintHostGfsToken({
      controlApiBaseUrl: "http://control-api:8090",
      signToken: () => "hcc-jwt",
      fetchFn,
    });

    expect(out.subject).toBe("host:1st:mcp-host/standalone");
    expect(out.token).toBe("tok");
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("http://control-api:8090/api/v1/auth/gfs/standalone/tokens");
    expect(init.headers.Authorization).toBe("Bearer hcc-jwt");
    expect(JSON.parse(init.body)).toEqual({ namespace: "mcp-host", scopes: ["gfs.read"] });
  });

  it("fails loud on a non-2xx response (never silently degrades)", async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 403 }) as Response) as unknown as typeof fetch;
    await expect(
      mintHostGfsToken({ controlApiBaseUrl: "http://x", signToken: () => "j", fetchFn })
    ).rejects.toThrow(/403/);
  });
});
