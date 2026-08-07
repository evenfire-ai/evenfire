import { describe, expect, it } from "vitest";
import { sanitizeForLog } from "./serve";

// CWE-117 log injection / log forging guard for the 5xx fail-loud log line in
// serve.ts, which interpolates user-controlled request fields (method, req.url)
// and the error message/stack. CR/LF (the forging vector) are removed via an
// empty-string replace that enumerates \n — the barrier CodeQL's js/log-injection
// query recognizes; other C0 controls + DEL become '?'. Sources are built via
// String.fromCharCode so this file carries no raw control bytes.
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const CRLF_CODES = [10, 13]; // removed entirely (recognized barrier)
const OTHER_CONTROL_CODES = [0, 8, 9, 27, 31, 127]; // NUL, BS, TAB, ESC, US, DEL

describe("sanitizeForLog (CWE-117 log-injection guard)", () => {
  it("removes CR and LF entirely (the log-forging vector)", () => {
    for (const code of CRLF_CODES) {
      expect(sanitizeForLog(`a${String.fromCharCode(code)}b`)).toBe("ab");
    }
  });

  it("replaces other C0 control chars and DEL with '?'", () => {
    for (const code of OTHER_CONTROL_CODES) {
      expect(sanitizeForLog(`a${String.fromCharCode(code)}b`)).toBe("a?b");
    }
  });

  it("neutralizes a CRLF forged-log-line payload", () => {
    const forge = `GET /x${CR}${LF}[gfsc] FAKE admin login -> 200`;
    const out = sanitizeForLog(forge);
    expect(out).not.toContain(LF);
    expect(out).not.toContain(CR);
    // CR/LF removed (not substituted) so no forged newline survives.
    expect(out).toBe("GET /x[gfsc] FAKE admin login -> 200");
  });

  it("passes through printable ASCII and unicode unchanged", () => {
    const ok = "/v1/resources/AbC-123_+/=?x=y&z=1 café";
    expect(sanitizeForLog(ok)).toBe(ok);
  });

  it("bounds length to 512 chars (log-flood guard)", () => {
    expect(sanitizeForLog("z".repeat(1000))).toHaveLength(512);
  });
});
