/**
 * Public halves of the three RSA keys that were once committed as dev JWT
 * defaults. These are verification material only — they cannot sign — and pin
 * the banned fingerprint list to the exact historical keys.
 */
export const BANNED_DEV_JWT_PUBLIC_KEYS = {
  rpc: `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArCIYGHehMPpGKePxaKQa
rDX5yrzifU5i4fzpI3EtkKSU6s5ug7EkKxc2DdMekoqXe9vr7qKyVwiilUIusXLX
iW7KPMJlD/Fd5Bo7Qxt69wYiL5I4K37eDgCN6D3LduHySEnkhdI0GDpB4LM2ASOx
QkEabepekZTMQyExmCIn/dHJ15B+4A9tiiephYOQNr3GcnW9eDomMt6NJLypikbr
xJO6O7Ar0G+raTbflth8EQzWnGF+WgQW4iiM3wsFhpaE0mUlEbMGDGTMAZy1KfxA
RRu+QZm3Lo+5AiCaHkijDCglHsXLhqsYi2AdRiavD1Gk9LKP/ztKw7q/D6fYFzmO
QwIDAQAB
-----END PUBLIC KEY-----`,

  session: `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwrZja9jS/r+e2YF1FqEQ
NMLsnffebYzXrZOb7uPMKhXBoKjJh/taR9v3kX2srfVtoikcKKr0Sfa7MMSLnZWd
ETmi7MvbeVD3HpsXpVejmw9D0zeYYSGZplLF/b6HY0Lz2XVM8WdJl3Dicyu+SZbZ
xeHZtMCMTTjvmoI/IYmmO4N3Pgz/SGi7V3EiwoALODP4OWDvd/1xFUiMPslLPgZU
EczQ5tIpAaD4e0om3gUNsyOKYc5igojm6ooVqI9T3TUGBVJ0uSZB7ntWxKQ39WyI
aH+oqnwDGbDcDLQ/wTuBtcn4brWTDgW1xA73HVBSImGFvvHCWBiQBiI1nvovUP0u
WQIDAQAB
-----END PUBLIC KEY-----`,

  admin: `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsrDvCYzx96OLO2qv37sb
ZZvCuguzR+cWxwOYpx61AP+GL9lxV60FJJJKjtRhO/Ivm6koOzgVyln12BphipB0
nJs9fdLzArpxeiuKaligrkL9c/2TwljmRpZagZzZKKAQR827b0WRz9qB63npbjMv
/7L1GNxcMtLne2rTAYU3gez0I7phwKAYH/zY+T5iH2l0qpt/4Iy6t7pWOQ0qgrKe
JPFe5qYWK3c8BWGnWJkhoLCNUCTnUa1yGaIHuRwKzwPH9b476rS72NGqGC4xRZXA
einOdIz3PympLN0HyIjSsPBUlhewILwD5jQBC6DxYeXLQJY0UHWRLrOqQRkJsep6
yQIDAQAB
-----END PUBLIC KEY-----`,
} as const
