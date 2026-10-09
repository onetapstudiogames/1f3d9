export type RetentionStep = Readonly<{
  run(): Promise<unknown>
  report(error: unknown): void
}>

/**
 * Run each log purge in its own try with its own failure report, in order, so
 * one failing purge never stops the next one in the same maintenance tick.
 */
export async function runEachRetention(steps: readonly RetentionStep[]): Promise<void> {
  for (const step of steps) {
    try {
      await step.run()
    } catch (error) {
      step.report(error)
    }
  }
}
