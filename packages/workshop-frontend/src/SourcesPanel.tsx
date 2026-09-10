import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowSquareOut, BookOpenText, CaretRight, MagnifyingGlass, Trash } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type {
  AuthorizedReturn,
  CitationMode,
  DocumentCitationView,
  DocumentEvidenceView,
  Evidence,
  EvidenceRef,
  EvidenceSource,
  Overseer,
  ToolReturnSummary,
} from "@gadgets/workshop-shared/api";
import { buildVaultNoteUrl } from "@gadgets/workshop-shared/citations";
import { WorkshopButton, WorkshopInput } from "./components/WorkshopControls";
import { reportIssue } from "./errorReporting";
import { formatDate, useLocale } from "./i18n";

type SourcesPanelProps = {
  overseer: RpcStub<Overseer>
  chatId: number | null
  gadgetId?: number
  isVisible: boolean
  documentSupported?: boolean | null
  documentEvidence?: DocumentEvidenceView | null
  documentEvidenceLoading?: boolean
  documentEvidenceError?: boolean
  onRefreshDocumentEvidence?: () => Promise<DocumentEvidenceView | null>
  focusCitationId?: string
  onNavigateToDocument?: (blockId: string, citationId: string) => void
}

type SourcesView = 'conversation' | 'document'

function returnStatus(

  entry: ToolReturnSummary,
  labels: {
    deleted: string
    partial: string
    failed: string
    unknown: string
    awaiting: string
    normalized: string
    invalid: string
    conflict: string
    unsupported: string
  },
): string {
  if (entry.captureState === 'deleted') return labels.deleted
  if (entry.captureState === 'partial') return labels.partial
  if (entry.captureState === 'failed' || entry.executionState === 'failed') return labels.failed
  if (entry.executionState === 'unknown') return labels.unknown
  return entry.observed ? labels[entry.normalizationState] : labels.awaiting
}
function evidenceRefKey(ref: Pick<EvidenceRef, 'returnId' | 'evidenceId'>): string {
  return `${ref.returnId}\u0000${ref.evidenceId}`
}

function citationStateLabel(
  state: DocumentCitationView['state'],
  t: ReturnType<typeof useLocale>['t'],
): string {
  switch (state) {
    case 'valid': return t('workspace.sources.citationValid')
    case 'needs_review': return t('workspace.sources.citationValid')
    case 'orphaned': return t('workspace.sources.citationOrphaned')
    case 'unavailable': return t('workspace.sources.citationUnavailable')
  }
}

function citationStateClass(state: DocumentCitationView['state']): string {
  switch (state) {
    case 'valid':
    case 'needs_review': return 'text-kumo-success'
    case 'orphaned':
    case 'unavailable': return 'text-kumo-danger'
  }
}


export function evidenceKindLabel(
  kind: Evidence['kind'],
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  switch (kind) {
    case 'fact': return t('workspace.sources.kindFact')
    case 'excerpt': return t('workspace.sources.kindExcerpt')
    case 'synthesis': return t('workspace.sources.kindSynthesis')
    case 'unknown': return t('workspace.sources.kindUnknown')
    default: return kind
  }
}

export type EvidenceMetadataTags = {
  kind: string
  confidence?: string
  sources: string[]
  sensitivities: string[]
}

export function deriveEvidenceMetadataTags(
  item: Evidence,
  sourcesById: Map<string, EvidenceSource>,
  t: (key: string, options?: Record<string, unknown>) => string,
): EvidenceMetadataTags {
  const itemSources = (item.sourceIds ?? [])
    .map(id => sourcesById.get(id))
    .filter((source): source is EvidenceSource => source !== undefined)

  const uniqueTypes = Array.from(new Set(
    itemSources
      .map(s => s.type?.trim())
      .filter((type): type is string => Boolean(type))
  ))

  const uniqueSensitivities = Array.from(new Set(
    itemSources
      .map(s => s.sensitivity?.trim())
      .filter((sensitivity): sensitivity is string => Boolean(sensitivity))
  ))

  const confidence = typeof item.confidence === 'number'
    && Number.isFinite(item.confidence)
    && item.confidence >= 0
    && item.confidence <= 1
    ? t('workspace.sources.confidenceTag', { percent: Math.round(item.confidence * 100) })
    : undefined

  return {
    kind: evidenceKindLabel(item.kind, t),
    confidence,
    sources: uniqueTypes.map(type => t('workspace.sources.sourceTypeTag', { type })),
    sensitivities: uniqueSensitivities.map(sensitivity =>
      t('workspace.sources.sourceSensitivityTag', { sensitivity }),
    ),
  }
}

function ReturnDetail({ value }: { value: AuthorizedReturn }) {
  const { t } = useLocale()
  if (value.status === 'unavailable') {
    return (
      <div className="rounded-lg border border-kumo-line bg-kumo-tint p-4 text-[13px] leading-[19px] text-kumo-subtle">
        {value.reason}
      </div>
    )
  }

  const sourcesById = new Map(value.sources.map(source => [source.id, source]))
  const byType = new Map<string, typeof value.sources>()
  for (const source of value.sources) {
    const group = byType.get(source.type)
    if (group) group.push(source)
    else byType.set(source.type, [source])
  }
  const evidenceById = new Map(value.evidence.map(item => [item.id, item]))
  const attachedEvidenceIds = new Set<string>()
  for (const source of value.sources) {
    for (const item of value.evidence) {
      if (item.sourceIds && item.sourceIds.includes(source.id)) {
        attachedEvidenceIds.add(item.id)
      }
    }
  }
  const unattachedEvidence = value.evidence.filter(item => !attachedEvidenceIds.has(item.id))

  return (
    <div className="space-y-5">
      <p className="m-0 text-[11px] text-kumo-inactive">
        {t('workspace.sources.returnedAt', {
          date: formatDate(new Date(value.return.calledAt), {
            dateStyle: 'medium',
            timeStyle: 'short',
          }),
        })}
      </p>
      {value.normalization.state !== 'normalized' && (
        <div className="rounded-lg border border-kumo-line bg-kumo-tint p-3 text-[12px] leading-[18px] text-kumo-subtle">
          {value.normalization.reason ?? t('workspace.sources.unstructured')}
        </div>
      )}

      {value.sources.length > 0 && (
        <section>
          <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-kumo-inactive">
            {t('workspace.sources.sourcesCount', { count: value.sources.length })}
          </h3>
          <div className="space-y-3">
            {[...byType.entries()].map(([type, sources]) => (
              <div key={type}>
                <p className="mb-1 text-[12px] font-medium text-kumo-subtle">{type}</p>
                <div className="space-y-2">
                  {sources.map(source => {
                    const noteUrl = buildVaultNoteUrl(value.return.vaultWebUrl, source.note)
                    const sourceEvidence = value.evidence.filter(item =>
                      item.sourceIds && item.sourceIds.includes(source.id)
                    )
                    return (
                      <div key={source.id} className="rounded-lg border border-kumo-line p-3 space-y-2">
                        <p className="m-0 text-[13px] font-medium text-kumo-default">
                          {source.title || source.ref}
                        </p>
                        {source.title && (
                          <p className="mt-0.5 break-all text-[11px] text-kumo-inactive">{source.ref}</p>
                        )}
                        <p className="m-0 text-[11px] text-kumo-inactive">
                          {source.occurredAt ?? t('workspace.sources.dateUnavailable')}
                          {source.sensitivity ? ` · ${source.sensitivity}` : ''}
                        </p>
                        {noteUrl && (
                          <div>
                            <a
                              href={noteUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-[12px] font-medium text-kumo-default hover:underline"
                            >
                              {t('workspace.sources.openVaultNote')}
                              <ArrowSquareOut size={13} aria-hidden="true" />
                            </a>
                          </div>
                        )}
                        {sourceEvidence.length > 0 && (
                          <div className="mt-2.5 space-y-2 border-t border-kumo-line/60 pt-2.5">
                            {sourceEvidence.map(item => {
                              const tags = deriveEvidenceMetadataTags(item, sourcesById, t)
                              return (
                                <div key={item.id} className="rounded-md bg-kumo-tint p-2.5">
                                  <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                                    <span className="inline-flex items-center rounded-full border border-kumo-line bg-kumo-base px-2 py-0.5 text-[11px] leading-4 text-kumo-subtle">
                                      {tags.kind}
                                    </span>
                                    {tags.confidence && (
                                      <span className="inline-flex items-center rounded-full border border-kumo-line bg-kumo-base px-2 py-0.5 text-[11px] leading-4 text-kumo-subtle">
                                        {tags.confidence}
                                      </span>
                                    )}
                                    {tags.sensitivities.map(tag => (
                                      <span
                                        key={tag}
                                        className="inline-flex items-center rounded-full border border-kumo-line bg-kumo-base px-2 py-0.5 text-[11px] leading-4 text-kumo-subtle"
                                      >
                                        {tag}
                                      </span>
                                    ))}
                                    {item.locator && (
                                      <span className="ml-auto text-[11px] text-kumo-inactive">{item.locator}</span>
                                    )}
                                  </div>
                                  <p className="m-0 whitespace-pre-wrap text-[12px] leading-[18px] text-kumo-default">
                                    {item.text}
                                  </p>
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {unattachedEvidence.length > 0 && (
        <section>
          <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-kumo-inactive">
            {t('workspace.sources.evidenceCount', { count: unattachedEvidence.length })}
          </h3>
          <div className="space-y-2">
            {unattachedEvidence.map(item => {
              const tags = deriveEvidenceMetadataTags(item, sourcesById, t)
              return (
                <article key={item.id} className="rounded-lg border border-kumo-line p-3">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-1.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="inline-flex items-center rounded-full border border-kumo-line bg-kumo-tint px-2 py-0.5 text-[11px] leading-4 text-kumo-subtle">
                        {tags.kind}
                      </span>
                      {tags.confidence && (
                        <span className="inline-flex items-center rounded-full border border-kumo-line bg-kumo-tint px-2 py-0.5 text-[11px] leading-4 text-kumo-subtle">
                          {tags.confidence}
                        </span>
                      )}
                      {tags.sources.map(tag => (
                        <span
                          key={tag}
                          className="inline-flex items-center rounded-full border border-kumo-line bg-kumo-tint px-2 py-0.5 text-[11px] leading-4 text-kumo-subtle"
                        >
                          {tag}
                        </span>
                      ))}
                      {tags.sensitivities.map(tag => (
                        <span
                          key={tag}
                          className="inline-flex items-center rounded-full border border-kumo-line bg-kumo-tint px-2 py-0.5 text-[11px] leading-4 text-kumo-subtle"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                    {item.locator && (
                      <span className="text-[11px] text-kumo-inactive">{item.locator}</span>
                    )}
                  </div>
                  <p className="m-0 whitespace-pre-wrap text-[13px] leading-[19px] text-kumo-default">
                    {item.text}
                  </p>
                </article>
              )
            })}
          </div>
        </section>
      )}
      {value.answerLinks.length > 0 && (
        <section>
          <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-kumo-inactive">
            {t('workspace.sources.answerLinks')}
          </h3>
          <div className="space-y-2">
            {value.answerLinks.map((link, index) => (
              <article key={`${link.claimIndex}-${index}`} className="rounded-lg border border-kumo-line p-3">
                <p className="m-0 text-[12px] font-medium text-kumo-subtle">
                  {t('workspace.sources.claim', { number: link.claimIndex + 1 })}
                </p>
                {link.evidenceIds.length > 0 && (
                  <ul className="mt-2 space-y-1.5 pl-4">
                    {link.evidenceIds.map(evidenceId => {
                      const item = evidenceById.get(evidenceId)
                      return (
                        <li key={evidenceId} className="text-[12px] leading-[18px] text-kumo-default">
                          <span className="font-mono text-[11px] text-kumo-inactive">{evidenceId}</span>
                          {item && <span className="ml-2">{item.text}</span>}
                        </li>
                      )
                    })}
                  </ul>
                )}
              </article>
            ))}
          </div>
        </section>
      )}

      <details className="rounded-lg border border-kumo-line">
        <summary className="cursor-pointer px-3 py-2 text-[12px] font-medium text-kumo-subtle">
          {t('workspace.sources.returnedContent')}
        </summary>
        <div className="space-y-3 border-t border-kumo-line p-3">
          {value.text !== undefined && (
            <div>
              <p className="mb-1 text-[11px] font-medium text-kumo-inactive">
                {t('workspace.sources.returnedText')}
              </p>
              <pre className="m-0 max-h-80 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-[17px] text-kumo-subtle">
                {value.text}
              </pre>
            </div>
          )}
          {value.structuredContent !== undefined && (
            <div>
              <p className="mb-1 text-[11px] font-medium text-kumo-inactive">
                {t('workspace.sources.structuredContent')}
              </p>
              <pre className="m-0 max-h-80 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-[17px] text-kumo-subtle">
                {JSON.stringify(value.structuredContent, null, 2)}
              </pre>
            </div>
          )}
          {value.content !== undefined && (
            <div>
              <p className="mb-1 text-[11px] font-medium text-kumo-inactive">
                {t('workspace.sources.contentBlocks')}
              </p>
              <pre className="m-0 max-h-80 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-[17px] text-kumo-subtle">
                {JSON.stringify(value.content, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </details>
    </div>
  )
}

type DocumentSourcesProps = {
  documentSupported?: boolean | null
  documentEvidence?: DocumentEvidenceView | null
  documentEvidenceLoading: boolean
  documentEvidenceError: boolean
  modeError?: string
  selectedCitationId?: string
  citationRefs: { current: Map<string, HTMLElement> }
  modeBusy: boolean
  onModeChange: (mode: CitationMode) => void
  onNavigateToDocument?: (blockId: string, citationId: string) => void
  onRemoveCitation?: (linkId: string) => void
}

function DocumentSources({
  documentSupported,
  documentEvidence,
  documentEvidenceLoading,
  documentEvidenceError,
  modeError,
  selectedCitationId,
  citationRefs,
  modeBusy,
  onModeChange,
  onNavigateToDocument,
  onRemoveCitation,
}: DocumentSourcesProps) {
  const { t } = useLocale()

  if (documentEvidenceLoading || documentSupported === null) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center text-[13px] text-kumo-subtle">
        {t('workspace.sources.documentLoading')}
      </div>
    )
  }

  if (documentSupported === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center text-[13px] text-kumo-subtle">
        {t('workspace.sources.noDocument')}
      </div>
    )
  }

  if (documentEvidenceError) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center text-[13px] text-kumo-danger">
        {t('workspace.sources.documentLoadFailed')}
      </div>
    )
  }

  if (!documentSupported) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <BookOpenText size={24} className="mb-3 text-kumo-inactive" />
        <p className="m-0 text-[13px] font-medium text-kumo-default">
          {t('workspace.sources.documentUnsupported')}
        </p>
        <p className="mt-1 max-w-xs text-[12px] leading-[18px] text-kumo-subtle">
          {t('workspace.sources.documentUnsupportedDescription')}
        </p>
      </div>
    )
  }

  if (!documentEvidence) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center text-[13px] text-kumo-subtle">
        {t('workspace.sources.documentLoadFailed')}
      </div>
    )
  }

  const evidenceByRef = new Map(
    documentEvidence.evidence.map(item => [evidenceRefKey(item.ref), item]),
  )
  const evidenceNumbers = new Map<string, number>()
  let nextEvidenceNumber = 1
  for (const link of documentEvidence.links) {
    if (link.state !== 'valid') continue
    for (const ref of link.evidence) {
      const key = evidenceRefKey(ref)
      if (!evidenceNumbers.has(key)) evidenceNumbers.set(key, nextEvidenceNumber++)
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="m-0 text-[14px] font-semibold text-kumo-default">
            {t('workspace.sources.documentCitations')}
          </h2>
          <p className="mt-1 text-[12px] text-kumo-subtle">
            {t('workspace.sources.documentCitationCount', { count: documentEvidence.links.length })}
          </p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-[11px] text-kumo-subtle">
          <span>{t('workspace.sources.citationMode')}</span>
          <select
            value={documentEvidence.mode}
            disabled={modeBusy}
            onChange={event => onModeChange(event.target.value as CitationMode)}
            className="h-8 rounded-md border border-kumo-line bg-kumo-base px-2 text-[12px] text-kumo-default"
          >
            <option value="inline">{t('workspace.sources.modeInline')}</option>
            <option value="endnotes">{t('workspace.sources.modeEndnotes')}</option>
            <option value="none">{t('workspace.sources.modeNone')}</option>
          </select>
        </label>
      </div>
      {modeError && (
        <p className="mt-2 text-[12px] text-kumo-danger">{modeError}</p>
      )}

      {documentEvidence.links.length === 0 ? (
        <div className="rounded-lg border border-kumo-line bg-kumo-tint p-4 text-[13px] text-kumo-subtle">
          {t('workspace.sources.noDocumentLinks')}
        </div>
      ) : (
        <div className="space-y-3">
          {documentEvidence.links.map((link, index) => {
            const selected = selectedCitationId === link.id
            const linkNumbers = link.evidence
              .map(ref => evidenceNumbers.get(evidenceRefKey(ref)))
              .filter((n): n is number => n !== undefined)
            const tagText = linkNumbers.length > 0 ? `[${linkNumbers.join(',')}]` : ''
            return (
              <article
                key={link.id}
                ref={node => {
                  if (node) citationRefs.current.set(link.id, node)
                  else citationRefs.current.delete(link.id)
                }}
                className={`rounded-lg border p-3.5 transition-colors ${
                  selected ? 'border-kumo-default bg-kumo-tint/40' : 'border-kumo-line bg-kumo-base'
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <p className="m-0 text-[13px] font-semibold text-kumo-default">
                      {t('workspace.sources.citationLink', { number: index + 1 })}
                    </p>
                    {tagText && (
                      <span className="font-mono text-[11px] font-bold text-kumo-default rounded border border-kumo-line bg-kumo-tint px-1.5 py-0.5 tracking-tight">
                        {tagText}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {onNavigateToDocument && (
                      <button
                        type="button"
                        onClick={event => {
                          event.stopPropagation()
                          onNavigateToDocument(link.blockId, link.id)
                        }}
                        className="rounded-md border border-kumo-line px-2 py-1 text-[11px] text-kumo-subtle hover:bg-kumo-tint"
                      >
                        {t('workspace.sources.openInDocument')}
                      </button>
                    )}
                    {onRemoveCitation && (
                      <button
                        type="button"
                        disabled={modeBusy}
                        onClick={event => {
                          event.stopPropagation()
                          onRemoveCitation(link.id)
                        }}
                        title={t('workspace.sources.removeCitation', { defaultValue: 'Remover menção' })}
                        className="rounded-md border border-kumo-line px-2 py-1 text-[11px] text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-danger"
                      >
                        {t('workspace.sources.removeCitation', { defaultValue: 'Remover menção' })}
                      </button>
                    )}
                  </div>
                </div>

                {link.evidence.length > 0 ? (
                  <div className="mt-3 space-y-3">
                    {link.evidence.map(ref => {
                      const item = evidenceByRef.get(evidenceRefKey(ref))
                      return (
                        <div key={evidenceRefKey(ref)} className="space-y-1.5 border-t border-kumo-line/50 pt-2.5 first:border-t-0 first:pt-0">
                          {item?.status === 'unavailable' ? (
                            <p className="m-0 text-[11px] text-kumo-inactive">
                              {t('workspace.sources.citationUnavailable')}
                            </p>
                          ) : null}
                          {item?.status === 'available' ? (
                            <>
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="inline-flex items-center rounded-full border border-kumo-line bg-kumo-tint px-2 py-0.5 text-[10px] leading-4 text-kumo-subtle font-medium">
                                  {evidenceKindLabel(item.evidence.kind, t)}
                                </span>
                                {typeof item.evidence.confidence === 'number' && (
                                  <span className="inline-flex items-center rounded-full border border-kumo-line bg-kumo-tint px-2 py-0.5 text-[10px] leading-4 text-kumo-subtle font-medium">
                                    {t('workspace.sources.confidenceTag', { percent: Math.round(item.evidence.confidence * 100) })}
                                  </span>
                                )}
                                {item.evidence.locator && (
                                  <span className="text-[10px] text-kumo-inactive">
                                    {item.evidence.locator}
                                  </span>
                                )}
                              </div>
                              <p className="m-0 whitespace-pre-wrap text-[13px] leading-[19px] text-kumo-default">
                                {item.evidence.text}
                              </p>
                              {item.sources.length > 0 && (
                                <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5 text-[11px]">
                                  <span className="truncate max-w-[70%] font-medium text-kumo-subtle">
                                    {item.sources[0]?.title || item.sources[0]?.ref}
                                  </span>
                                  {(() => {
                                    const noteUrl = buildVaultNoteUrl(item.vaultWebUrl, item.sources[0]?.note)
                                    return noteUrl ? (
                                      <a
                                        href={noteUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-1 font-medium text-kumo-default hover:underline shrink-0"
                                      >
                                        {t('workspace.sources.openVaultNote')}
                                        <ArrowSquareOut size={12} aria-hidden="true" />
                                      </a>
                                    ) : null
                                  })()}
                                </div>
                              )}
                            </>
                          ) : (
                            <p className="m-0 text-[12px] leading-[18px] text-kumo-danger">
                              {item?.status === 'unavailable'
                                ? item.reason
                                : t('workspace.sources.citationUnavailableDescription')}
                            </p>
                          )}
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <p className="mt-2 text-[12px] text-kumo-subtle">
                    {t('workspace.sources.noCitationEvidence')}
                  </p>
                )}
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default function SourcesPanel({
  overseer,
  chatId,
  gadgetId,
  isVisible,
  documentSupported,
  documentEvidence,
  documentEvidenceLoading = false,
  documentEvidenceError = false,
  onRefreshDocumentEvidence,
  focusCitationId,
  onNavigateToDocument,
}: SourcesPanelProps) {
  const { t } = useLocale()
  const [view, setView] = useState<SourcesView>('conversation')
  const [entries, setEntries] = useState<ToolReturnSummary[]>([])
  const [nextBeforeId, setNextBeforeId] = useState<string>()
  const [selectedId, setSelectedId] = useState<string>()
  const [detail, setDetail] = useState<AuthorizedReturn>()
  const [query, setQuery] = useState('')
  const [sourceType, setSourceType] = useState('')
  const [connectorId, setConnectorId] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string>()
  const [reload, setReload] = useState(0)
  const listGenerationRef = useRef(0)


  const [selectedCitationId, setSelectedCitationId] = useState<string>()
  const [modeBusy, setModeBusy] = useState(false)
  const [modeError, setModeError] = useState<string>()
  const citationRefs = useRef(new Map<string, HTMLElement>())

  useEffect(() => {
    const generation = ++listGenerationRef.current
    const isCurrent = () => listGenerationRef.current === generation
    setEntries([])
    setNextBeforeId(undefined)
    setLoadingMore(false)
    setError(undefined)
    setSelectedId(undefined)
    setDetail(undefined)

    if (!isVisible || view !== 'conversation' || chatId === null) {
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    const timeout = window.setTimeout(() => {
      overseer.listReturns({
        chatId,
        ...(query.trim() ? { query: query.trim() } : {}),
        ...(sourceType ? { sourceType } : {}),
        ...(connectorId ? { connectorId: Number(connectorId) } : {}),
      }).then(page => {
        if (cancelled || !isCurrent()) return
        setEntries(page.entries)
        setNextBeforeId(page.nextBeforeId)
      }).catch(cause => {
        if (cancelled || !isCurrent()) return
        reportIssue('sources.list', cause)
        setError(cause instanceof Error ? cause.message : String(cause))
        setEntries([])
        setNextBeforeId(undefined)
      }).finally(() => {
        if (!cancelled && isCurrent()) setLoading(false)
      })
    }, 200)
    return () => {
      cancelled = true
      window.clearTimeout(timeout)
      if (isCurrent()) listGenerationRef.current += 1
    }
  }, [chatId, connectorId, isVisible, overseer, query, reload, sourceType, view])

  useEffect(() => {
    if (!isVisible || !selectedId) return
    let cancelled = false
    setDetail(undefined)
    overseer.getReturn(selectedId).then(value => {
      if (!cancelled) setDetail(value)
    }).catch(cause => {
      if (cancelled) return
      reportIssue('sources.detail', cause)
      setError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => { cancelled = true }
  }, [isVisible, overseer, selectedId, reload])
  useEffect(() => {
    if (!focusCitationId || !isVisible) return
    setView('document')
    setSelectedCitationId(focusCitationId)
  }, [focusCitationId, isVisible])

  useEffect(() => {
    if (!focusCitationId || !isVisible || view !== 'document' ||
        !documentEvidence?.links.some(link => link.id === focusCitationId)) return
    const frame = window.requestAnimationFrame(() => {
      citationRefs.current.get(focusCitationId)?.scrollIntoView({block: 'nearest'})
    })
    return () => window.cancelAnimationFrame(frame)
  }, [documentEvidence, focusCitationId, isVisible, view])

  useEffect(() => {
    if (!documentEvidence) {
      setSelectedCitationId(undefined)
      return
    }
    if (selectedCitationId &&
        !documentEvidence.links.some(link => link.id === selectedCitationId)) {
      setSelectedCitationId(undefined)
    }
  }, [documentEvidence, selectedCitationId])
  useEffect(() => {
    setModeError(undefined)
  }, [chatId, gadgetId])


  const connectorOptions = useMemo(() => {
    const options = new Map<number, string>()
    for (const entry of entries) {
      options.set(entry.gatekeeperId, entry.connectorTitle || `#${entry.gatekeeperId}`)
    }
    return [...options.entries()]
  }, [entries])
  const sourceTypeOptions = useMemo(() =>
    [...new Set(entries.flatMap(entry => entry.observed ? entry.sourceTypes : []))].sort(), [entries])

  const statusLabels = {
    deleted: t('workspace.sources.statusDeleted'),
    partial: t('workspace.sources.statusPartial'),
    failed: t('workspace.sources.statusFailed'),
    unknown: t('workspace.sources.statusUnknown'),
    awaiting: t('workspace.sources.statusAwaiting'),
    normalized: t('workspace.sources.statusNormalized'),
    invalid: t('workspace.sources.statusInvalid'),
    conflict: t('workspace.sources.statusConflict'),
    unsupported: t('workspace.sources.statusUnsupported'),
  }
  const loadMore = async () => {
    if (chatId === null || !nextBeforeId || loadingMore) return
    const generation = listGenerationRef.current
    const isCurrent = () => listGenerationRef.current === generation
    setLoadingMore(true)
    try {
      const page = await overseer.listReturns({
        chatId,
        beforeId: nextBeforeId,
        ...(query.trim() ? { query: query.trim() } : {}),
        ...(sourceType ? { sourceType } : {}),
        ...(connectorId ? { connectorId: Number(connectorId) } : {}),
      })
      if (!isCurrent()) return
      setEntries(current => [...current, ...page.entries])
      setNextBeforeId(page.nextBeforeId)
    } catch (cause) {
      if (!isCurrent()) return
      reportIssue('sources.list-more', cause)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (isCurrent()) setLoadingMore(false)
    }
  }

  const deleteSelected = async () => {
    if (!selectedId || !window.confirm(t('workspace.sources.deleteConfirm'))) return
    try {
      await overseer.deleteReturn(selectedId)
      setSelectedId(undefined)
      setDetail(undefined)
      setReload(value => value + 1)
    } catch (cause) {
      reportIssue('sources.delete', cause)
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const changeCitationMode = async (mode: CitationMode) => {
    const current = documentEvidence
    if (!current || gadgetId === undefined || chatId === null ||
        mode === current.mode || modeBusy) return
    setModeBusy(true)
    setModeError(undefined)
    try {
      let result = await overseer.setCitationMode({
        gadgetId: current.gadgetId,
        expectedCitationRevision: current.citationRevision,
        mode,
      }, chatId)
      if (result.status === 'conflict') {
        // One fresh projection is enough to recover a stale citation CAS. A second conflict is
        // reported rather than spinning or applying a mode change against a newer revision.
        const refreshed = await onRefreshDocumentEvidence?.()
        if (!refreshed) throw new Error('Unable to refresh document citations.')
        result = await overseer.setCitationMode({
          gadgetId: refreshed.gadgetId,
          expectedCitationRevision: refreshed.citationRevision,
          mode,
        }, chatId)
      }
      if (result.status === 'conflict') {
        setModeError(t('workspace.sources.modeConflict'))
        return
      }
      await onRefreshDocumentEvidence?.()
    } catch (cause) {
      reportIssue('sources.mode', cause)
      setModeError(t('workspace.sources.modeUpdateFailed'))
    } finally {
      setModeBusy(false)
    }
  }
  const removeCitationLink = async (linkId: string) => {
    const current = documentEvidence
    if (!current || gadgetId === undefined || chatId === null || modeBusy) return
    setModeBusy(true)
    setModeError(undefined)
    try {
      const nextLinks = current.links
        .filter(link => link.id !== linkId)
        .map(link => ({
          id: link.id,
          blockId: link.blockId,
          evidence: link.evidence.map(ref => ({ ...ref })),
        }))

      let result = await overseer.setDocumentCitations({
        gadgetId: current.gadgetId,
        expectedDocumentRevision: current.documentRevision,
        expectedCitationRevision: current.citationRevision,
        links: nextLinks,
        mode: current.mode,
      }, chatId)

      if (result.status === 'conflict') {
        const refreshed = await onRefreshDocumentEvidence?.()
        if (!refreshed) throw new Error('Unable to refresh document citations.')
        const retryLinks = refreshed.links
          .filter(link => link.id !== linkId)
          .map(link => ({
            id: link.id,
            blockId: link.blockId,
            evidence: link.evidence.map(ref => ({ ...ref })),
          }))
        result = await overseer.setDocumentCitations({
          gadgetId: refreshed.gadgetId,
          expectedDocumentRevision: refreshed.documentRevision,
          expectedCitationRevision: refreshed.citationRevision,
          links: retryLinks,
          mode: refreshed.mode,
        }, chatId)
      }
      if (result.status === 'conflict') {
        setModeError(t('workspace.sources.modeConflict'))
        return
      }
      await onRefreshDocumentEvidence?.()
    } catch (cause) {
      reportIssue('sources.removeLink', cause)
      setModeError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setModeBusy(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-kumo-base">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-kumo-line px-3">
        <button type="button" onClick={() => setView('conversation')}
          className={`rounded-md px-3 py-1.5 text-[13px] ${view === 'conversation' ? 'bg-kumo-tint font-medium text-kumo-default' : 'text-kumo-subtle'}`}>
          {t('workspace.sources.fromConversation')}
        </button>
        <button type="button" onClick={() => setView('document')}
          className={`rounded-md px-3 py-1.5 text-[13px] ${view === 'document' ? 'bg-kumo-tint font-medium text-kumo-default' : 'text-kumo-subtle'}`}>
          {t('workspace.sources.fromDocument')}
        </button>
      </div>

      {view === 'document' ? (
        <DocumentSources
          documentSupported={documentSupported}
          documentEvidence={documentEvidence}
          documentEvidenceLoading={documentEvidenceLoading}
          documentEvidenceError={documentEvidenceError}
          modeError={modeError}
          selectedCitationId={selectedCitationId}
          citationRefs={citationRefs}
          modeBusy={modeBusy}
          onModeChange={changeCitationMode}
          onNavigateToDocument={onNavigateToDocument}
          onRemoveCitation={removeCitationLink}
        />
      ) : chatId === null ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-[13px] text-kumo-subtle">
          {t('workspace.sources.selectConversation')}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside className={`${selectedId ? 'hidden md:flex' : 'flex'} w-full min-w-0 flex-col border-r border-kumo-line md:w-[42%]`}>
            <div className="space-y-2 border-b border-kumo-line p-3">
              <div className="relative">
                <MagnifyingGlass size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-kumo-inactive" />
                <WorkshopInput value={query} onChange={event => setQuery(event.target.value)}
                  maxLength={200} placeholder={t('workspace.sources.search')} className="w-full !pl-9" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <select value={connectorId} onChange={event => setConnectorId(event.target.value)}
                  className="h-8 min-w-0 rounded-md border border-kumo-line bg-kumo-base px-2 text-[12px] text-kumo-default">
                  <option value="">{t('workspace.sources.allConnectors')}</option>
                  {connectorOptions.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                </select>
                <select value={sourceType} onChange={event => setSourceType(event.target.value)}
                  className="h-8 min-w-0 rounded-md border border-kumo-line bg-kumo-base px-2 text-[12px] text-kumo-default">
                  <option value="">{t('workspace.sources.allTypes')}</option>
                  {sourceTypeOptions.map(type => <option key={type} value={type}>{type}</option>)}
                </select>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
              {loading ? (
                <p className="p-4 text-[13px] text-kumo-subtle">{t('workspace.sources.loading')}</p>
              ) : error ? (
                <p className="p-4 text-[13px] text-kumo-danger">{error}</p>
              ) : entries.length === 0 ? (
                <p className="p-4 text-[13px] leading-[19px] text-kumo-subtle">{t('workspace.sources.empty')}</p>
              ) : entries.map(entry => (
                <button key={entry.id} type="button" onClick={() => setSelectedId(entry.id)}
                  className={`flex w-full items-center gap-3 border-b border-kumo-line px-3 py-3 text-left hover:bg-kumo-tint ${selectedId === entry.id ? 'bg-kumo-tint' : ''}`}>
                  <div className="min-w-0 flex-1">
                    <p className="m-0 truncate text-[13px] font-medium text-kumo-default">{entry.tool}</p>
                    <p className="mt-0.5 truncate text-[11px] text-kumo-inactive">
                      {entry.connectorTitle || `#${entry.gatekeeperId}`} · {formatDate(new Date(entry.calledAt), { dateStyle: 'medium', timeStyle: 'short' })}
                    </p>
                    <p className="mt-1 text-[11px] text-kumo-subtle">
                      {entry.observed
                        ? <>{returnStatus(entry, statusLabels)} · {t('workspace.sources.sourceEvidenceCounts', {
                          sources: entry.sourceCount,
                          evidence: entry.evidenceCount,
                        })}</>
                        : returnStatus(entry, statusLabels)}
                    </p>
                  </div>
                  <CaretRight size={14} className="shrink-0 text-kumo-inactive" />
                </button>
              ))}
              {nextBeforeId && (
                <div className="p-3">
                  <WorkshopButton onClick={loadMore} disabled={loadingMore} className="w-full">
                    {loadingMore ? t('workspace.sources.loading') : t('workspace.sources.loadOlder')}
                  </WorkshopButton>
                </div>
              )}
            </div>
          </aside>

          <main className={`${selectedId ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 flex-col`}>
            {selectedId && (
              <div className="flex h-11 shrink-0 items-center justify-between border-b border-kumo-line px-3">
                <button type="button" onClick={() => setSelectedId(undefined)}
                  className="text-[12px] text-kumo-subtle md:hidden">
                  {t('workspace.sources.back')}
                </button>
                <span className="truncate text-[12px] font-medium text-kumo-default">{selectedId}</span>
                <button type="button" onClick={deleteSelected}
                  title={t('workspace.sources.deleteReturn')} aria-label={t('workspace.sources.deleteReturn')}
                  className="grid h-8 w-8 place-items-center rounded-md text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-danger">
                  <Trash size={15} />
                </button>
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-auto p-4">
              {selectedId
                ? detail ? <ReturnDetail value={detail} /> : <p className="text-[13px] text-kumo-subtle">{t('workspace.sources.loading')}</p>
                : <div className="flex h-full items-center justify-center text-[13px] text-kumo-subtle">{t('workspace.sources.selectReturn')}</div>}
            </div>
          </main>
        </div>
      )}
    </div>
  )
}
