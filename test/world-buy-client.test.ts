import { registerSignedPaymentTests } from './world-buy-client-tests/signed-payment.test.ts'
import { registerServerProseTests } from './world-buy-client-tests/server-prose.test.ts'
import { registerPaymentResumeTests } from './world-buy-client-tests/payment-resume.test.ts'
import { registerRequestIdTests } from './world-buy-client-tests/request-id.test.ts'
import { registerPublicProofTests } from './world-buy-client-tests/public-proof.test.ts'
import { registerCheckoutBindingTests } from './world-buy-client-tests/checkout-binding.test.ts'
import { registerNewWalletTests } from './world-buy-client-tests/new-wallet.test.ts'
import { registerPaidClaimTimeoutTests } from './world-buy-client-tests/paid-claim-timeout.test.ts'

registerSignedPaymentTests()
registerServerProseTests()
registerPaymentResumeTests()
registerRequestIdTests()
registerPublicProofTests()
registerCheckoutBindingTests()
registerNewWalletTests()
registerPaidClaimTimeoutTests()
