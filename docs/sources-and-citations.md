# Sources and document citations

The Workshop retains an authorized tool result as private conversation history when the result is observed. **Sources** exposes that retained result without re-running the tool or consulting the provider again.

## Sources views

- **From this conversation** lists retained observed results for the selected chat. Search and filters operate only on data already stored in the Workshop.
- **From this document** lists evidence explicitly linked to the selected document. A second document in the same chat does not inherit those links.
- A result distinguishes the historical excerpt returned by the tool from the current source. For a native Vault result with a frozen Vault web origin and resolved note identity, **Open note in Vault** opens `/app/notas?brain=…&slug=…` in a new tab. The Vault performs its own human authentication and current authorization check.
- Results from generic MCP servers, old captures, or connections without a trusted Vault web association remain readable but do not gain a guessed Vault link.

Only the workspace owner can read, search, delete, cite, or export retained evidence. Disconnecting the source or losing a later provider grant does not rewrite the historical result already observed by the Workshop. It also does not grant access to the current note: the Vault remains authoritative for that read.

Deleting a retained result removes its private payload and normalized evidence. Existing citation links remain as unavailable references and never recover the deleted excerpt from a cache. Deleting the conversation removes all its retained results. There is no automatic TTL or retroactive capture.

## Document citations

The official Workspace Docs format publishes the document citation capability. Citation links target a whole stable block and retain the block ID, version, and HTML hash observed when the link was confirmed.

The presentation mode is shared by the document UI and the agent tools:

- `inline`: markers appear at the end of cited blocks.
- `endnotes`: the same markers appear with a numbered evidence list.
- `none`: citation presentation is hidden without deleting links.

Numbers follow current block order and first evidence occurrence. Reusing evidence in another block reuses its number.

Moving an unchanged block keeps its citation valid. Editing its HTML or version marks the link as needing review; removing the block makes it orphaned; deleting the retained result makes it unavailable. Links needing review or without a block remain visible in Sources but are not rendered as valid document markers. An unavailable link retains only the minimal `[?]` marker when its block still exists.

Citation markers are projections, not document content. Workspace Docs strips markers before saving canonical block HTML. Custom or older document gadgets that do not publish the capability continue to work and show the conversation Sources view, but do not receive citation support by title or output label.

## Export and copying boundaries

Workspace Docs reuses the existing Markdown, HTML, and PDF exporters. Each owner export freezes one document-and-citation projection before rendering:

- `inline` exports visible markers.
- `endnotes` exports markers and the visible numbered evidence list.
- `none` exports neither markers nor endnotes and does not pass evidence text to the export handler.
- Links needing review or orphaned are excluded. Unavailable links export only `[?]`.

The projection contains the current document plus only cited visible evidence and safe source links. It excludes raw MCP payloads, uncited evidence, return IDs, citation IDs, block hashes, tokens, and hidden citation metadata. Collaborator exports do not receive the owner's private evidence projection. Gadgets without the citation capability and legacy Workspace Docs instances that have not initialized blocks retain their previous citation-free export path.

Blueprint publication, `.gadget` download/import, forks, and sharing copy code only. They do not copy private `ToolReturn` or `CitationSet` records. An explicitly downloaded Markdown, HTML, or PDF file is an external copy; later deletion in the Workshop or revocation in the Vault cannot recall that file.

Focused regression coverage lives in:

- `packages/workshop-backend/__tests__/citations.test.ts`
- `packages/workshop-backend/__tests__/browser-export.test.ts`
- `packages/workshop-backend/__tests__/format-blueprints.test.ts`
- `packages/workshop-frontend/src/GadgetUI.integration.test.tsx`
- `packages/workshop-frontend/src/SourcesPanel.test.ts`
