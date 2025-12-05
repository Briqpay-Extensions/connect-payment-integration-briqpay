async function preUndeploy(): Promise<void> {
  // No pre-undeploy actions required
  return Promise.resolve()
}

async function run() {
  try {
    await preUndeploy()
  } catch (error) {
    if (error instanceof Error) {
      process.stderr.write(`Post-undeploy failed: ${error.message}\n`)
    }
    process.exitCode = 1
  }
}
void run()
