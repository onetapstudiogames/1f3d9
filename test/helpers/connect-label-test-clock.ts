import type { TestContext } from 'node:test'
import { CONNECT_LABEL_TEST_END } from '../../src/door-profile.ts'

// Decision 162 lists every /mcp/connect tool with destructiveHint false until
// CONNECT_LABEL_TEST_END. A test of the decision 135 labels on that door pins the clock to
// one second after the end, when the door serves those labels again.
export function afterConnectLabelTest(t: TestContext): void {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(CONNECT_LABEL_TEST_END) + 1_000 })
}
