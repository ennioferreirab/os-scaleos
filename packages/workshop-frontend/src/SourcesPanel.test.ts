import { describe, expect, it } from "vitest";
import { buildVaultNoteUrl } from "@gadgets/workshop-shared/citations";
import type { Evidence, EvidenceSource } from "@gadgets/workshop-shared/api";
import { deriveEvidenceMetadataTags } from "./SourcesPanel";
describe('buildVaultNoteUrl', () => {
  it('uses the frozen Vault base and encodes note identity', () => {
    const result = buildVaultNoteUrl(
      'https://vault.example.test/portal?ignored=1#old',
      { brain: 'team/road map', slug: 'note & 1' },
    )

    expect(result).toBeDefined()
    const url = new URL(result!)
    expect(url.origin).toBe('https://vault.example.test')
    expect(url.pathname).toBe('/app/notas')
    expect(url.searchParams.get('brain')).toBe('team/road map')
    expect(url.searchParams.get('slug')).toBe('note & 1')
    expect(url.searchParams.has('ignored')).toBe(false)
    expect(url.hash).toBe('')
  })

  it('does not create a link without a trusted base or complete note identity', () => {
    expect(buildVaultNoteUrl(undefined, { brain: 'team', slug: 'note' })).toBeUndefined()
    expect(buildVaultNoteUrl('javascript:alert(1)', { brain: 'team', slug: 'note' })).toBeUndefined()
    expect(buildVaultNoteUrl('https://user:pass@vault.example.test', { brain: 'team', slug: 'note' })).toBeUndefined()
    expect(buildVaultNoteUrl('https://vault.example.test', undefined)).toBeUndefined()
    expect(buildVaultNoteUrl('https://vault.example.test', { brain: '', slug: 'note' })).toBeUndefined()
    expect(buildVaultNoteUrl('https://vault.example.test', { brain: 'team', slug: '' })).toBeUndefined()
    expect(buildVaultNoteUrl('https://vault.example.test', { brain: ' ', slug: 'note' })).toBeUndefined()
    expect(buildVaultNoteUrl('https://vault.example.test', { brain: 'team', slug: ' ' })).toBeUndefined()
    expect(buildVaultNoteUrl(
      'https://vault.example.test',
      null as unknown as { brain: string; slug: string },
    )).toBeUndefined()
  })
})
describe('deriveEvidenceMetadataTags', () => {
  const ptTranslations: Record<string, string> = {
    'workspace.sources.kindFact': 'Fato',
    'workspace.sources.kindExcerpt': 'Trecho',
    'workspace.sources.kindSynthesis': 'Síntese',
    'workspace.sources.kindUnknown': 'Desconhecido',
    'workspace.sources.confidenceTag': 'Confiança: {{percent}}%',
    'workspace.sources.sourceTypeTag': 'Fonte: {{type}}',
    'workspace.sources.sourceSensitivityTag': 'Sensibilidade: {{sensitivity}}',
  }

  const mockT = (translations: Record<string, string>) =>
    (key: string, options?: Record<string, unknown>) => {
      let str = translations[key] ?? key
      if (options) {
        for (const [k, v] of Object.entries(options)) {
          str = str.replace(`{{${k}}}`, String(v))
        }
      }
      return str
    }

  it('derives localized tags for fact with confidence, source type and sensitivity', () => {
    const sourcesById = new Map<string, EvidenceSource>([
      [
        'src_1',
        {
          id: 'src_1',
          ref: 'reuniao-1',
          type: 'reunioes',
          sensitivity: 'interno',
        },
      ],
    ])

    const item: Evidence = {
      id: 'ev_1',
      sourceIds: ['src_1'],
      kind: 'fact',
      text: 'A entrega foi acordada para 20 de outubro.',
      confidence: 0.45,
      locator: '00:12:04',
    }

    const tags = deriveEvidenceMetadataTags(item, sourcesById, mockT(ptTranslations))
    expect(tags.kind).toBe('Fato')
    expect(tags.confidence).toBe('Confiança: 45%')
    expect(tags.sources).toEqual(['Fonte: reunioes'])
    expect(tags.sensitivities).toEqual(['Sensibilidade: interno'])
  })

  it('deduplicates source types and sensitivities across multiple sourceIds', () => {
    const sourcesById = new Map<string, EvidenceSource>([
      ['src_1', { id: 'src_1', ref: 'call-1', type: 'reunioes', sensitivity: 'interno' }],
      ['src_2', { id: 'src_2', ref: 'call-2', type: 'reunioes', sensitivity: 'interno' }],
      ['src_3', { id: 'src_3', ref: 'doc-1', type: 'documentos', sensitivity: 'restrito' }],
    ])

    const item: Evidence = {
      id: 'ev_multi',
      sourceIds: ['src_1', 'src_2', 'src_3'],
      kind: 'fact',
      text: 'Fato com múltiplas fontes.',
    }

    const tags = deriveEvidenceMetadataTags(item, sourcesById, mockT(ptTranslations))
    expect(tags.kind).toBe('Fato')
    expect(tags.confidence).toBeUndefined()
    expect(tags.sources).toEqual(['Fonte: reunioes', 'Fonte: documentos'])
    expect(tags.sensitivities).toEqual(['Sensibilidade: interno', 'Sensibilidade: restrito'])
  })

  it('omits absent metadata without producing empty tags', () => {
    const sourcesById = new Map<string, EvidenceSource>([
      ['src_empty', { id: 'src_empty', ref: 'empty-source', type: '', sensitivity: '' }],
    ])

    const item: Evidence = {
      id: 'ev_empty',
      sourceIds: ['src_empty', 'src_missing'],
      kind: 'synthesis',
      text: 'Síntese sem metadados.',
    }

    const tags = deriveEvidenceMetadataTags(item, sourcesById, mockT(ptTranslations))
    expect(tags.kind).toBe('Síntese')
    expect(tags.confidence).toBeUndefined()
    expect(tags.sources).toEqual([])
    expect(tags.sensitivities).toEqual([])
  })

  it('localizes kind and tags in English', () => {
    const enTranslations: Record<string, string> = {
      'workspace.sources.kindFact': 'Fact',
      'workspace.sources.confidenceTag': 'Confidence: {{percent}}%',
      'workspace.sources.sourceTypeTag': 'Source: {{type}}',
      'workspace.sources.sourceSensitivityTag': 'Sensitivity: {{sensitivity}}',
    }

    const sourcesById = new Map<string, EvidenceSource>([
      ['src_1', { id: 'src_1', ref: 'meeting-1', type: 'meeting', sensitivity: 'internal' }],
    ])

    const item: Evidence = {
      id: 'ev_1',
      sourceIds: ['src_1'],
      kind: 'fact',
      text: 'Delivery agreed.',
      confidence: 0.45,
    }

    const tags = deriveEvidenceMetadataTags(item, sourcesById, mockT(enTranslations))
    expect(tags.kind).toBe('Fact')
    expect(tags.confidence).toBe('Confidence: 45%')
    expect(tags.sources).toEqual(['Source: meeting'])
    expect(tags.sensitivities).toEqual(['Sensitivity: internal'])
  })
})
