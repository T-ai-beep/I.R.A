import type { SessionSummary } from '../pipeline/session.js'

export interface CRMAdapter {
  logCall(summary: SessionSummary): Promise<void>
}

const OUTCOME_TO_STAGE: Record<string, string> = {
  agreement: 'closedwon',
  lost:      'closedlost',
  stalled:   'followup',
  expired:   'followup',
  manual:    'followup',
}

export function outcomeToStage(outcome: string): string {
  return OUTCOME_TO_STAGE[outcome] ?? 'followup'
}

export async function getCRMAdapter(): Promise<CRMAdapter | null> {
  const { CONFIG } = await import('../config.js')
  if (!CONFIG.CRM_PROVIDER || !CONFIG.CRM_API_KEY) return null

  if (CONFIG.CRM_PROVIDER === 'hubspot') {
    const { HubSpotAdapter } = await import('./hubspot.js')
    return new HubSpotAdapter(CONFIG.CRM_API_KEY)
  }

  console.warn(`[CRM] unknown provider: ${CONFIG.CRM_PROVIDER}`)
  return null
}
