import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { HttpRequestTool, isPrivateIp } from '../httpRequest'
import { ShellTool } from '../shell'

let workspacePath: string

beforeEach(async () => {
  workspacePath = await mkdtemp(join(tmpdir(), 'clerum-test-'))
})

afterEach(async () => {
  await rm(workspacePath, { recursive: true, force: true })
})

describe('ShellTool', () => {
  it('should declare requiresApproval() = true (Risk 3.5.2a)', () => {
    const tool = new ShellTool(workspacePath, 5000, ['PATH'])
    expect(tool.requiresApproval()).toBe(true)
  })

  it('should kill process on timeout (Risk 3.5.2b)', async () => {
    const tool = new ShellTool(workspacePath, 500, ['PATH']) // 500ms timeout

    const result = await tool.execute({ command: 'sleep 60' })

    expect(result.is_error).toBe(true)
    expect(result.content).toContain('timeout')
  })

  it('should sandbox HOME to workspace path', async () => {
    const tool = new ShellTool(workspacePath, 5000, ['PATH'])

    const result = await tool.execute({ command: 'echo $HOME' })

    expect(result.is_error).toBe(false)
    expect(result.content).toContain(workspacePath)
  })

  it('should execute full shell syntax (pipes, redirects)', async () => {
    const tool = new ShellTool(workspacePath, 5000, ['PATH'])

    const result = await tool.execute({ command: 'echo hello | wc -c' })

    expect(result.is_error).toBe(false)
    expect(result.content).toContain('6')
  })
})

describe('HttpRequestTool', () => {
  it('should declare requiresApproval() = true', () => {
    const tool = new HttpRequestTool(['api.example.com'])
    expect(tool.requiresApproval()).toBe(true)
  })

  it('should block domains not in allowlist (Risk 3.5.3a)', async () => {
    const tool = new HttpRequestTool(['api.example.com'])
    const result = await tool.execute({ url: 'http://evil.com/steal' })

    expect(result.is_error).toBe(true)
    expect(result.content).toContain('not in allowlist')
  })

  it('should detect private/metadata IPs (Risk 3.5.3b)', () => {
    // Test the isPrivateIp function directly (DNS mock not needed)
    expect(isPrivateIp('169.254.169.254')).toBe(true) // Cloud metadata
    expect(isPrivateIp('10.0.0.1')).toBe(true) // RFC 1918
    expect(isPrivateIp('172.16.0.1')).toBe(true) // RFC 1918
    expect(isPrivateIp('192.168.1.1')).toBe(true) // RFC 1918
    expect(isPrivateIp('127.0.0.1')).toBe(true) // Loopback
    expect(isPrivateIp('0.0.0.0')).toBe(true) // Zero
    expect(isPrivateIp('8.8.8.8')).toBe(false) // Public
    expect(isPrivateIp('1.1.1.1')).toBe(false) // Public
  })

  it('should block request when DNS fails and allowlist is configured (Risk 3.5.3d)', async () => {
    const tool = new HttpRequestTool(['example.com'])
    const result = await tool.execute({
      url: 'http://definitely-does-not-exist-12345.example.com/test',
    })

    expect(result.is_error).toBe(true)
    // Should fail with DNS resolution error, not a generic HTTP error
    expect(result.content).toContain('DNS resolution failed')
  })

  it('should detect IPv6 private/loopback addresses (Risk 3.5.3c)', () => {
    expect(isPrivateIp('::1')).toBe(true) // IPv6 loopback
    expect(isPrivateIp('::')).toBe(true) // Unspecified
    expect(isPrivateIp('fc00::1')).toBe(true) // Unique local
    expect(isPrivateIp('fd12::1')).toBe(true) // Unique local
    expect(isPrivateIp('fe80::1')).toBe(true) // Link-local
    expect(isPrivateIp('::ffff:10.0.0.1')).toBe(true) // IPv4-mapped private
    expect(isPrivateIp('::ffff:192.168.1.1')).toBe(true) // IPv4-mapped private
    expect(isPrivateIp('2001:db8::1')).toBe(false) // Documentation (public-ish)
    expect(isPrivateIp('2607:f8b0::1')).toBe(false) // Google public
  })

  it('should close IPv6 bypass vectors (Risk 3.5.3c — follow-up)', () => {
    // Long-form loopback (was bypass — startsWith("::1") missed it)
    expect(isPrivateIp('0:0:0:0:0:0:0:1')).toBe(true)
    expect(isPrivateIp('0000:0000:0000:0000:0000:0000:0000:0001')).toBe(true)
    // Long-form unspecified
    expect(isPrivateIp('0:0:0:0:0:0:0:0')).toBe(true)
    // Bracketed hostname (what url.hostname returns for http://[::1])
    expect(isPrivateIp('[::1]')).toBe(true)
    // Zone identifier
    expect(isPrivateIp('fe80::1%eth0')).toBe(true)
    // IPv4-mapped written in hex (was bypass — prefix check required dotted quad)
    expect(isPrivateIp('::ffff:7f00:1')).toBe(true) // 127.0.0.1
    expect(isPrivateIp('::ffff:a00:1')).toBe(true) // 10.0.0.1
    expect(isPrivateIp('::ffff:c0a8:101')).toBe(true) // 192.168.1.1
    // 172.16/12 IPv4-mapped must honor the 16–31 bound, not just "172."
    expect(isPrivateIp('::ffff:172.16.0.1')).toBe(true)
    expect(isPrivateIp('::ffff:172.31.255.255')).toBe(true)
    expect(isPrivateIp('::ffff:172.15.0.1')).toBe(false) // Public
    expect(isPrivateIp('::ffff:172.32.0.1')).toBe(false) // Public
    // 169.254 cloud metadata via IPv4-mapped
    expect(isPrivateIp('::ffff:169.254.169.254')).toBe(true)
    // Uppercase + compact forms
    expect(isPrivateIp('FE80::1')).toBe(true)
    expect(isPrivateIp('FD00::1')).toBe(true)
    // Malformed-but-colon-bearing fails closed (defense in depth)
    expect(isPrivateIp(':::')).toBe(true)
    expect(isPrivateIp('not-an-ip:::')).toBe(true)
    // Public IPv6 still passes
    expect(isPrivateIp('2607:f8b0:4004:c1b::200e')).toBe(false)
  })

  it('should detect IPv4-compatible ::x.x.x.x SSRF bypass', () => {
    // IPv4-compatible (deprecated RFC 4291 form, still parseable). These
    // are *not* IPv4-mapped (no ffff hextets) — the previous implementation
    // only caught the ffff form and let these through.
    expect(isPrivateIp('::192.168.1.1')).toBe(true) // RFC 1918
    expect(isPrivateIp('::10.0.0.1')).toBe(true) // RFC 1918
    expect(isPrivateIp('::172.16.0.1')).toBe(true) // RFC 1918
    expect(isPrivateIp('::169.254.169.254')).toBe(true) // Cloud metadata
    expect(isPrivateIp('::127.0.0.1')).toBe(true) // Loopback
    // Hex form of the same bypass — bytes[10..11]==0, bytes[12..15]!=0.
    expect(isPrivateIp('::c0a8:101')).toBe(true) // ::192.168.1.1
    expect(isPrivateIp('::a00:1')).toBe(true) // ::10.0.0.1
    expect(isPrivateIp('::a9fe:a9fe')).toBe(true) // ::169.254.169.254
    // Public IPv4-compatible — returns false (valid, non-SSRF target).
    expect(isPrivateIp('::8.8.8.8')).toBe(false)
    expect(isPrivateIp('::1.1.1.1')).toBe(false)
  })
})
