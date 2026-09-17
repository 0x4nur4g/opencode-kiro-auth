// Registers the kiro_web_search tool on the V2 host (ctx.tool.transform).
// One-argument add(); the 3-arg form crashes on 2.0.6.

import type { AccountManager } from '../plugin/accounts.js'
import type { KiroConfig } from '../plugin/config/schema.js'
import { formatWebSearchResults, kiroWebSearch } from '../plugin/web-search.js'
import type { PluginContext, Registration } from './host-types.js'

// Adapted from Kiro's own web_search tool spec so the model gets the same
// guidance on when to search and how to attribute results.
const WEB_SEARCH_DESCRIPTION = `Search the web using Kiro's built-in search engine. Returns titles, URLs, snippets, domains, and publish dates for a query. Billed as Kiro credits.

## When to Use
- The user asks for current or up-to-date information (pricing, versions, release notes, recent events, library APIs).
- Verifying facts that may have changed recently, or details likely newer than the model's training data.
- Looking up specifics of a library, framework, or tool that can't be reliably inferred from the codebase or context.

## When NOT to Use
- Basic concepts, historical facts, or well-established programming syntax the model already knows.
- Anything answerable from the current repository, files, or conversation. Search the codebase first.

## Query Tips
- Keep queries focused; the query MUST be 200 characters or fewer (longer queries are rejected).
- Rephrase the user's request into effective keywords. Run multiple focused searches for complex questions rather than one broad query.
- The snippets often contain enough to answer directly; only fetch a full page (via a separate fetch tool) when you need more detail.

## Using Results & Attribution
- Prioritize the most recently published, authoritative sources (prefer official docs over blogs; use the domain to judge authority).
- ALWAYS cite sources with inline links in the format [description](url).
- Paraphrase and summarize; do not reproduce more than ~30 consecutive words verbatim from any single source. Preserve factual accuracy while condensing.`

export interface KiroToolsDeps {
  config: KiroConfig
  accountManager: AccountManager
}

export async function registerKiroTools(
  ctx: PluginContext,
  deps: KiroToolsDeps
): Promise<Registration> {
  return ctx.tool.transform((editor) => {
    if (editor.get('kiro_web_search')) return
    if (!deps.config.web_search_enabled) return
    const account = deps.accountManager.getCurrentOrNext()
    if (!account?.profileArn) return

    editor.add({
      name: 'kiro_web_search',
      description: WEB_SEARCH_DESCRIPTION,
      input: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query. Must be 200 characters or fewer.'
          }
        },
        required: ['query'],
        additionalProperties: false
      },
      execute: async (rawInput) => {
        const query = String((rawInput as { query?: unknown })?.query ?? '')
        try {
          const results = await kiroWebSearch(deps.accountManager, query)
          return { content: [{ type: 'text', text: formatWebSearchResults(results) }] }
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: `Web search failed: ${error instanceof Error ? error.message : String(error)}`
              }
            ]
          }
        }
      }
    })
  })
}
