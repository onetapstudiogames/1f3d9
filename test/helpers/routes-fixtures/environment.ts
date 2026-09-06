const LATER_HOLDER_CURSOR_KEY = '11'.repeat(32)
const TREASURY = '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd'

export function installFakeEnvironment(): void {
  process.env.DATABASE_URL = 'postgresql://fake:fake@fake-host.example.neon.tech/fakedb'
  process.env.TREASURY_ADDRESS = TREASURY
  process.env.PUBLIC_ORIGIN = 'https://1f3d9.com'
  process.env.BASE_RPC_URL = 'https://base-rpc.test'
  process.env.FACILITATOR_URL = 'https://facilitator.test'
  process.env.LATER_HOLDER_CURSOR_KEY = LATER_HOLDER_CURSOR_KEY
  process.env.VERCEL_GIT_COMMIT_SHA = 'e'.repeat(40)
  process.env.CODING_IDENTITY_DOORS_ENABLED = 'true'
}

const SELLER_WALLET = '0x1111111111111111111111111111111111111111'
const BUYER_WALLET = '0x2222222222222222222222222222222222222222'
const STRANGER_WALLET = '0x3333333333333333333333333333333333333333'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const SECRET = '1f3d9_sk_' + 'ab'.repeat(24)
const OTHER_SECRET = '1f3d9_sk_' + 'cd'.repeat(24)
const TX1 = '0x' + '11'.repeat(32)
const TX2 = '0x' + '22'.repeat(32)
const TX_CASE_UPPER = '0x' + 'AB'.repeat(32)
const AUTHORIZATION_NOW = Math.floor(Date.now() / 1000)
const CONTRACT_DRAWING = Object.freeze({
  palette: Object.freeze(['#ad3f25', '#f0c95f']),
  indices: Object.freeze(Array.from(
    { length: 64 },
    (_, index) => index % 3 === 0 ? null : index % 2,
  )),
})
const CONTRACT_DRAWING_DESCRIPTION = 'A warm lantern with a sunlit brass frame.'
function xPayment(
  payer: string,
  payee: string,
  amountUnits: number,
  nonceDigit: string,
): string {
  return Buffer.from(JSON.stringify({
    x402Version: 1,
    scheme: 'exact',
    network: 'base',
    payload: {
      signature: '0x' + 'ef'.repeat(65),
      authorization: {
        from: payer,
        to: payee,
        value: String(amountUnits),
        validAfter: String(AUTHORIZATION_NOW - 120),
        validBefore: String(AUTHORIZATION_NOW + 3600),
        nonce: '0x' + nonceDigit.repeat(32),
      },
    },
  }), 'utf8').toString('base64')
}
const X_PAYMENT = xPayment(SELLER_WALLET, TREASURY, 1_000_000, 'aa')
const X_PAYMENT_NO_ID = xPayment(SELLER_WALLET, TREASURY, 1_000_000, 'bb')
const SALE_X_PAYMENT = xPayment(BUYER_WALLET, SELLER_WALLET, 2_000_000, 'cc')
const STRANGER_SALE_X_PAYMENT = xPayment(STRANGER_WALLET, SELLER_WALLET, 2_000_000, 'dd')

export {
  AUTHORIZATION_NOW,
  BUYER_WALLET,
  CONTRACT_DRAWING,
  CONTRACT_DRAWING_DESCRIPTION,
  LATER_HOLDER_CURSOR_KEY,
  OTHER_SECRET,
  SALE_X_PAYMENT,
  SECRET,
  SELLER_WALLET,
  STRANGER_SALE_X_PAYMENT,
  STRANGER_WALLET,
  TRANSFER_TOPIC,
  TREASURY,
  TX1,
  TX2,
  TX_CASE_UPPER,
  USDC,
  X_PAYMENT,
  X_PAYMENT_NO_ID,
  xPayment,
}
