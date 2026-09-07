import { registerWebhookVerificationTests } from './paypal-credit-delivery-routes-tests/webhook-verification.test.ts'
import { registerDisputeCaptureReconciliationTests } from './paypal-credit-delivery-routes-tests/dispute-capture-reconciliation.test.ts'
import { registerCaptureReplayTests } from './paypal-credit-delivery-routes-tests/capture-replay.test.ts'
import { registerDisputeOutcomeTests } from './paypal-credit-delivery-routes-tests/dispute-outcomes.test.ts'
import { registerCrossRailDeliveryTests } from './paypal-credit-delivery-routes-tests/cross-rail-delivery.test.ts'

registerWebhookVerificationTests()
registerDisputeCaptureReconciliationTests()
registerCaptureReplayTests()
registerDisputeOutcomeTests()
registerCrossRailDeliveryTests()
