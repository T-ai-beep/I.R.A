// Standalone demo entrypoint — no audio deps
async function main() {
  console.log('[DEMO] entrypoint reached')

  const runAll = process.argv.includes('--all')
  const scenario = (process.argv.find(a => a.startsWith('--scenario='))?.split('=')[1] ?? 'negotiation') as any

  console.log(runAll ? '[DEMO] running all scenarios' : `[DEMO] scenario: ${scenario}`)

  const { runDemo, runAllDemos } = await import('./pipeline/demo.js')

  if (runAll) {
    await runAllDemos()
  } else {
    await runDemo(scenario, { speak: false, verbose: true })
  }

  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })