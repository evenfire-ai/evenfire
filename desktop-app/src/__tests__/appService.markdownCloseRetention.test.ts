import { describe, expect, it } from 'vitest'
import { AppService } from '../appService'

describe('AppService Markdown close retention', () => {
  it('bounds the real service record count across sequential close completions', () => {
    const service = new AppService() as any
    const documentEpoch = '00000000-0000-4000-8000-000000000042'
    service.beginMarkdownTabCloseDocument(42, documentEpoch)

    for (let sequence = 1; sequence <= 500; sequence += 1) {
      const binding = {
        requestId: `tab-a:close-${sequence}`,
        documentEpoch,
        sequence,
        tabId: 'tab-a',
        sessionGeneration: 0,
        ownerIdentities: [`owner-${sequence}`],
      }
      expect(service.authorizeMarkdownTabClose(42, binding)).toBe('granted')
      expect(service.consumeMarkdownTabClosePermit(42, binding)).toBe('consumed')
      expect(service.acknowledgeMarkdownTabClose(42, binding)).toBe(sequence + 1)
      expect(service.markdownTabCloseDocuments.size).toBe(1)
      const document = service.markdownTabCloseDocuments.get(42)
      expect(document.slot.kind).toBe('ack')
      expect(Object.keys(document).sort()).toEqual(['epoch', 'nextSequence', 'slot'])
      expect(document.slot.receipt.binding.ownerIdentities).toBeUndefined()
    }

    expect(service.markdownTabCloseDocuments.get(42).slot.receipt.nextSequence).toBe(501)
  })
})
