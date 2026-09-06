import { initialState, fixtureState } from './state.ts'
import type { FakeState } from './state.ts'



function reset(patch: Partial<FakeState> = {}) {
  fixtureState.current = { ...initialState(), ...patch }
}

async function withVercelForwarding(run: () => Promise<void>) {
  const previous = process.env.VERCEL
  process.env.VERCEL = '1'
  try {
    await run()
  } finally {
    if (previous === undefined) delete process.env.VERCEL
    else process.env.VERCEL = previous
  }
}

function setActor(id: number, handle: string) {
  fixtureState.current = { ...fixtureState.current, actorId: id, actorHandle: handle }
}

function recordPayment(query: string, params: unknown[]) {
  if (!/insert\s+into\s+payment_uses/i.test(query)) return
  if (fixtureState.current.failPaidWriteOnce && /insert\s+into\s+places/i.test(query)) return
  const raw = params.find(value => /^0x[0-9a-fA-F]{64}$/.test(String(value)))
  if (!raw) return
  const canonical = String(raw).toLowerCase()
  if (fixtureState.current.paymentHashes.has(canonical)) {
    throw Object.assign(new Error('payment proof already used'), { code: '23505' })
  }
  fixtureState.current = { ...fixtureState.current, paymentHashes: new Set([...fixtureState.current.paymentHashes, canonical]) }
}

function integerArrayValue(value: unknown): number[] | null {
  let decoded: unknown = value
  if (typeof value === 'string') {
    try {
      decoded = value.startsWith('[')
        ? JSON.parse(value)
        : value.startsWith('{')
          ? value.slice(1, -1).split(',').filter(Boolean)
          : value
    } catch {
      return null
    }
  }
  if (!Array.isArray(decoded)) return null
  const ids = decoded.map(item => Number(
    typeof item === 'string' ? item.replace(/^"|"$/gu, '') : item,
  ))
  return ids.every(id => Number.isSafeInteger(id) && id > 0) ? ids : null
}

function frontMatterIdsIn(params: readonly unknown[]): number[] | null {
  for (const value of params) {
    const ids = integerArrayValue(value)
    if (ids !== null) return ids
  }
  const individualIds = params
    .map(Number)
    .filter(id => Number.isSafeInteger(id) && id >= 41 && id <= 44)
  return individualIds.length > 0 ? individualIds : null
}

function roomPurposeIn(params: readonly unknown[]): string | null {
  return (params.find(value => typeof value === 'string' && (
    [
      'safe',
      'two\nlines',
      'A small room for deliberate reading.',
      'A retry-safe reading room.',
      'Keep the old description.',
    ].includes(value) || value.length === 281
  )) as string | undefined) ?? null
}

export {
  frontMatterIdsIn,
  recordPayment,
  reset,
  roomPurposeIn,
  setActor,
  withVercelForwarding,
}
