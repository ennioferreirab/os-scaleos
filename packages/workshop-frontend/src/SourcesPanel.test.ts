import { describe, expect, it } from "vitest";
import { buildVaultNoteUrl } from "@gadgets/workshop-shared/citations";

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
