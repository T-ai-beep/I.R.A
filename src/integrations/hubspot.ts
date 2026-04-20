import type { SessionSummary } from '../pipeline/session.js'
import type { CRMAdapter } from './crm.js'
import { outcomeToStage } from './crm.js'

const BASE = 'https://api.hubapi.com'

export class HubSpotAdapter implements CRMAdapter {
  constructor(private apiKey: string) {}

  private async hs(path: string, method: string, body?: object): Promise<unknown> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`HubSpot ${method} ${path} → ${res.status}: ${text}`)
    }
    return res.json()
  }

  private async upsertContact(name: string | null): Promise<string | null> {
    if (!name) return null
    const parts    = name.trim().split(/\s+/)
    const firstName = parts[0] ?? ''
    const lastName  = parts.slice(1).join(' ')

    try {
      const search = await this.hs('/crm/v3/objects/contacts/search', 'POST', {
        filterGroups: [{
          filters: [{ propertyName: 'firstname', operator: 'EQ', value: firstName }],
        }],
        properties: ['firstname', 'lastname'],
        limit: 1,
      }) as { results: Array<{ id: string }> }

      if (search.results.length > 0) return search.results[0].id

      const created = await this.hs('/crm/v3/objects/contacts', 'POST', {
        properties: { firstname: firstName, lastname: lastName },
      }) as { id: string }
      return created.id
    } catch (e) {
      console.error('[CRM][HubSpot] upsertContact failed:', e)
      return null
    }
  }

  private async createDeal(summary: SessionSummary, contactId: string | null): Promise<string | null> {
    const stage = outcomeToStage(summary.outcome)
    const props: Record<string, unknown> = {
      dealname:  `ARIA — ${summary.mode} — ${new Date(summary.startTs).toLocaleDateString()}`,
      dealstage: stage,
      pipeline:  'default',
    }
    if (summary.lastOffer) props.amount = summary.lastOffer

    try {
      const deal = await this.hs('/crm/v3/objects/deals', 'POST', {
        properties: props,
        associations: contactId ? [{
          to: { id: contactId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }],
        }] : [],
      }) as { id: string }
      return deal.id
    } catch (e) {
      console.error('[CRM][HubSpot] createDeal failed:', e)
      return null
    }
  }

  private async attachNote(summary: SessionSummary, dealId: string): Promise<void> {
    const lines = [
      `Mode: ${summary.mode}`,
      `Outcome: ${summary.outcome}`,
      `Duration: ${Math.round(summary.durationMs / 1000)}s`,
      `Turns: ${summary.turnCount}`,
      summary.lastOffer ? `Last offer: $${summary.lastOffer}` : null,
      '',
      summary.summary,
      summary.nextStep ? `\nNext step: ${summary.nextStep}` : null,
    ].filter(l => l !== null).join('\n')

    try {
      await this.hs('/crm/v3/objects/notes', 'POST', {
        properties: {
          hs_note_body:      lines,
          hs_timestamp:      String(summary.startTs),
        },
        associations: [{
          to: { id: dealId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 214 }],
        }],
      })
    } catch (e) {
      console.error('[CRM][HubSpot] attachNote failed:', e)
    }
  }

  async logCall(summary: SessionSummary): Promise<void> {
    const personName = summary.people?.[0] ?? null
    console.log(`[CRM][HubSpot] syncing session — ${summary.outcome} — ${personName ?? 'unknown contact'}`)

    const contactId = await this.upsertContact(personName)
    const dealId    = await this.createDeal(summary, contactId)
    if (dealId) await this.attachNote(summary, dealId)

    console.log(`[CRM][HubSpot] done — deal=${dealId ?? 'failed'} contact=${contactId ?? 'none'}`)
  }
}
