// Standalone demo entrypoint — no audio deps
async function main() {
  console.log('[DEMO] entrypoint reached')
  const scenario = (process.argv.find(a => a.startsWith('--scenario='))?.split('=')[1] ?? 'negotiation') as any
  console.log(`[DEMO] scenario: ${scenario}`)
  const { runDemo } = await import('./pipeline/demo.js')
  await runDemo(scenario, { speak: false, verbose: true })
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })