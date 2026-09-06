import { canonicalPaymentRequest } from './source-imports.ts'
import {
  AUTHORIZATION_NOW,
  BUYER_WALLET,
  CONTRACT_DRAWING,
  CONTRACT_DRAWING_DESCRIPTION,
  OTHER_SECRET,
  SALE_X_PAYMENT,
  SECRET,
  SELLER_WALLET,
  STRANGER_WALLET,
  TREASURY,
  TX1,
  TX2,
  TX_CASE_UPPER,
  X_PAYMENT,
  X_PAYMENT_NO_ID,
} from './environment.ts'
import {
  fixtureState,
  paidCompletionError,
} from './state.ts'
import type {
  FakeCityCreditEntry,
  FakeCommunityToolSubmission,
  FakeFounderPayPalDispute,
  FakeLaterHolderItem,
  FakePaymentAttempt,
} from './state.ts'
import {
  descendingPage,
  kindRow,
  mapOutlineParent,
  mapOutlineRows,
  paginationEvents,
  paginationNotes,
  paginationSubplaces,
  paginationThings,
  placeRow,
  recentIds,
  remainingPaginationRows,
  residentArrivalPage,
  residentArrivalRows,
  residentHandleForFakeId,
  residentRow,
  roomOrientationThingRow,
  selectedPlacePermission,
  thingRow,
  visibleRoomFrontMatter,
} from './rows.ts'
import {
  frontMatterIdsIn,
  recordPayment,
  roomPurposeIn,
} from './state-tools.ts'

export function respondToDatabaseStage6(
  query: string,
  params: unknown[],
  q: string,
): Record<string, unknown>[] | undefined {


  if (q.includes('left join resident_presence presence')) {
    return [
      { id: 9, handle: 'long-gone', current_place_id: 1, joined_at: '2026-07-01T00:00:00.000Z', asleep: true },
      { id: 7, handle: 'tiny-lantern', current_place_id: 2, joined_at: '2026-08-11T00:00:00.000Z', asleep: false },
    ]
  }
  if (q.includes('with recursive place_tree')) {
    if (fixtureState.current.scenario === 'large map') {
      const rows = [placeRow(1, null)]
      for (let id = 2; id <= 1401; id += 1) rows.push(placeRow(id, 1))
      for (let step = 0; step < 16; step += 1) {
        rows.push(placeRow(3000 + step, step === 0 ? 1 : 2999 + step))
      }
      return rows
    }
    return [placeRow(1, null), placeRow(2, 1)]
  }
  if (q.includes('insert into places')) {
    if (fixtureState.current.failPaidWriteOnce) {
      fixtureState.current = { ...fixtureState.current, failPaidWriteOnce: false }
      return []
    }
    if (fixtureState.current.paidCompletionFailure && /complete_city_credit_attempt/iu.test(q)) {
      const failure = fixtureState.current.paidCompletionFailure
      fixtureState.current = { ...fixtureState.current, paidCompletionFailure: null }
      throw paidCompletionError(failure)
    }
    const returned = placeRow(3, 2)
    const creditAttemptId = String(params.find(value =>
      typeof value === 'string' && value.startsWith('credit_attempt_')) ?? '')
    if (creditAttemptId && q.includes('complete_city_credit_attempt')) {
      const attempt = fixtureState.current.paymentAttempts.get(creditAttemptId)
      const assetMatches = !q.includes("asset_type = 'kind' AND asset_id =")
        || (attempt?.asset_type === 'kind' && attempt.asset_id === 3)
      if (attempt && assetMatches) {
        const balance = fixtureState.current.cityCreditBalances.get(attempt.actor_id) ?? 0n
        const response = {
          place: returned,
          city_fee_credit: {
            spent_usdc: '1.000000',
            balance_usdc: `${balance / 1_000_000n}.${String(balance % 1_000_000n).padStart(6, '0')}`,
          },
        }
        const responseBody = JSON.stringify(response)
        fixtureState.current = {
          ...fixtureState.current,
          paymentAttempts: new Map(fixtureState.current.paymentAttempts).set(creditAttemptId, {
            ...attempt,
            status: 'completed',
            lease_owner: null,
            lease_expires_at: null,
            result_json: { kind: 'place', id: returned.id },
            response_status: 201,
            response_json: response,
            response_body_bytes: Buffer.from(responseBody, 'utf8'),
            updated_at: '2026-08-11T00:00:00.000Z',
            completed_at: '2026-08-11T00:00:00.000Z',
          }),
        }
        return [{ ...returned, response_body: responseBody }]
      }
    }
    if (q.includes('complete_payment_attempt')) {
      const attemptId = String(params.find(value => typeof value === 'string' && value.startsWith('pay_')) ?? '')
      const attempt = fixtureState.current.paymentAttempts.get(attemptId)
      if (attempt) {
        const responseBody = JSON.stringify({ place: returned, fee_tx: TX1.toLowerCase() })
        const durable = attempt.response_json?.__1f3d9_x402_response_v1
        const header = durable && typeof durable === 'object' && !Array.isArray(durable)
          ? String((durable as Record<string, unknown>).header ?? '')
          : ''
        fixtureState.current = {
          ...fixtureState.current,
          paymentAttempts: new Map(fixtureState.current.paymentAttempts).set(attemptId, {
            ...attempt,
            status: 'completed',
            lease_owner: null,
            lease_expires_at: null,
            result_json: { kind: 'place', id: returned.id },
            response_status: 201,
            response_json: {
              __1f3d9_x402_response_v1: {
                ...(header ? { header } : {}),
                body: JSON.parse(responseBody) as Record<string, unknown>,
              },
            },
            response_body_bytes: Buffer.from(responseBody, 'utf8'),
            updated_at: '2026-08-11T00:00:00.000Z',
            completed_at: '2026-08-11T00:00:00.000Z',
          }),
        }
      }
    }
    return [{
      ...returned,
      ...(q.includes('complete_payment_attempt') ? {
        response_body: JSON.stringify({ place: returned, fee_tx: TX1.toLowerCase() }),
      } : {}),
    }]
  }
  if (q.includes('update places set'))
    return fixtureState.current.actorId === fixtureState.current.placeOwnerId ? [{ ...placeRow(2, 1), description: 'changed by its owner' }] : []
  if (q.includes('from places') && q.includes('parent_id') && !q.includes('update things')) {
    return [selectedPlacePermission(placeRow(2, 1), q)]
  }
  if (q.includes('from places') && (q.includes('where p.id') || q.includes('where id'))) {
    return [selectedPlacePermission(placeRow(2, 1), q)]
  }

  if (q.includes('insert into kinds') || q.includes('insert into kind_revisions') || q.includes('update kinds')) {
    if (fixtureState.current.failPaidWriteOnce) {
      fixtureState.current = { ...fixtureState.current, failPaidWriteOnce: false }
      return []
    }
    if (fixtureState.current.paidCompletionFailure && /complete_city_credit_attempt/iu.test(q)) {
      const failure = fixtureState.current.paidCompletionFailure
      fixtureState.current = { ...fixtureState.current, paidCompletionFailure: null }
      throw paidCompletionError(failure)
    }
    const returned = { ...kindRow(), revision: fixtureState.current.kindRevision + 1 }
    const creditAttemptId = String(params.find(value =>
      typeof value === 'string' && value.startsWith('credit_attempt_')) ?? '')
    if (creditAttemptId && q.includes('complete_city_credit_attempt')) {
      const attempt = fixtureState.current.paymentAttempts.get(creditAttemptId)
      const assetMatches = !q.includes("asset_type = 'kind' AND asset_id =")
        || (attempt?.asset_type === 'kind' && attempt.asset_id === 3)
      if (attempt && assetMatches) {
        const balance = fixtureState.current.cityCreditBalances.get(attempt.actor_id) ?? 0n
        const response = {
          kind: returned,
          city_fee_credit: {
            spent_usdc: '1.000000',
            balance_usdc: `${balance / 1_000_000n}.${String(balance % 1_000_000n).padStart(6, '0')}`,
          },
        }
        const responseBody = JSON.stringify(response)
        const status = q.includes('insert into kinds') ? 201 : 200
        fixtureState.current = {
          ...fixtureState.current,
          paymentAttempts: new Map(fixtureState.current.paymentAttempts).set(creditAttemptId, {
            ...attempt,
            status: 'completed',
            lease_owner: null,
            lease_expires_at: null,
            result_json: { kind: 'kind_revision', id: returned.id, revision: returned.revision },
            response_status: status,
            response_json: response,
            response_body_bytes: Buffer.from(responseBody, 'utf8'),
            updated_at: '2026-08-11T00:00:00.000Z',
            completed_at: '2026-08-11T00:00:00.000Z',
          }),
        }
        return [{ ...returned, response_body: responseBody }]
      }
    }
    if (q.includes('complete_payment_attempt')) {
      const attemptId = String(params.find(value => typeof value === 'string' && value.startsWith('pay_')) ?? '')
      const attempt = fixtureState.current.paymentAttempts.get(attemptId)
      if (attempt) {
        const responseBody = JSON.stringify({ kind: returned, fee_tx: TX1.toLowerCase() })
        const durable = attempt.response_json?.__1f3d9_x402_response_v1
        const header = durable && typeof durable === 'object' && !Array.isArray(durable)
          ? String((durable as Record<string, unknown>).header ?? '')
          : ''
        fixtureState.current = {
          ...fixtureState.current,
          paymentAttempts: new Map(fixtureState.current.paymentAttempts).set(attemptId, {
            ...attempt,
            status: 'completed',
            lease_owner: null,
            lease_expires_at: null,
            result_json: { kind: 'kind_revision', id: returned.id, revision: returned.revision },
            response_status: q.includes('insert into kinds') ? 201 : 200,
            response_json: {
              __1f3d9_x402_response_v1: {
                ...(header ? { header } : {}),
                body: JSON.parse(responseBody) as Record<string, unknown>,
              },
            },
            response_body_bytes: Buffer.from(responseBody, 'utf8'),
            updated_at: '2026-08-11T00:00:00.000Z',
            completed_at: '2026-08-11T00:00:00.000Z',
          }),
        }
      }
    }
    return [{
      ...returned,
      ...(q.includes('complete_payment_attempt') ? {
        response_body: JSON.stringify({ kind: returned, fee_tx: TX1.toLowerCase() }),
      } : {}),
    }]
  }
  if (q.includes('/* public:kinds */')) {
    const row = kindRow()
    return [{
      ...row,
      total_items: 1,
      total_text_bytes: Buffer.byteLength(String(row.description ?? ''), 'utf8'),
    }]
  }
  if ((q.includes('from kind_revisions') || q.includes('from kinds'))
      && !q.includes('things thing')) {
    if (q.includes('insert into') || q.includes('update kinds')) return [{ ...kindRow(), revision: fixtureState.current.kindRevision + 1 }]
    return [kindRow()]
  }
  if (q.includes('insert into traits')) return [{
    id: 4,
    name: 'glowing',
    description: 'gives off light',
    recipe: fixtureState.current.traitHasRecipe ? [{ effect: 'label', value: 'lit' }] : null,
    mechanical: fixtureState.current.traitHasRecipe,
    coiner: fixtureState.current.actorHandle,
  }]
  if (q.includes('kind_revision_traits')) {
    return fixtureState.current.thingTraitRecipe ? [{ trait_id: 4, recipe: fixtureState.current.thingTraitRecipe }] : []
  }
  if (q.includes('/* public:traits */')) {
    const row = {
      id: 4,
      name: fixtureState.current.placeLawNames.length ? fixtureState.current.lawTraitName : 'glowing',
      description: 'gives off light',
      recipe: fixtureState.current.placeLawNames.length ? fixtureState.current.lawTraitRecipe : null,
      mechanical: fixtureState.current.placeLawNames.length ? Boolean(fixtureState.current.lawTraitRecipe) : false,
      coiner: 'founder',
    }
    return [{
      ...row,
      total_items: 1,
      total_text_bytes: Buffer.byteLength(row.description, 'utf8'),
    }]
  }
  if (q.includes('from traits')) return [{
    id: 4,
    name: fixtureState.current.placeLawNames.length ? fixtureState.current.lawTraitName : 'glowing',
    description: 'gives off light',
    recipe: fixtureState.current.placeLawNames.length ? fixtureState.current.lawTraitRecipe : null,
    mechanical: fixtureState.current.placeLawNames.length ? Boolean(fixtureState.current.lawTraitRecipe) : false,
    coiner: 'founder',
  }]

  if (q.includes('/* note-action:recent-duplicate */')) {
    const note = fixtureState.current.recentNote
    const hasPhaseAwareGazettePredicate = q.includes('gazette_withdrawals_are_open()')
      && q.includes('gazette_withdrawal_command_reserved(note.body)')
      && q.includes('from gazette_withdrawals')
      && q.includes('command_note_id')
    const reservedAfterActivation = note?.place_id === 454
      && fixtureState.current.gazetteWithdrawalsOpen
      && /^WITHDRAW\s*#/u.test(note.body)
      && !fixtureState.current.gazetteWithdrawalCommandIds.has(note.id)
    return note
      && note.author_id === Number(params[0])
      && note.place_id === Number(params[1])
      && note.body === String(params[2])
      && (!hasPhaseAwareGazettePredicate || !reservedAfterActivation)
      ? [{ ...note }]
      : []
  }
  if (q.includes('/* note-action:gazette-command-reserved */')) {
    return [{
      command_reserved: fixtureState.current.gazetteWithdrawalsOpen
        && /^WITHDRAW\s*#/u.test(String(params[0] ?? '')),
    }]
  }
  if (q.includes('/* note-action:gazette-withdrawal */')) {
    const commandNoteId = Number(params[0])
    const note = fixtureState.current.recentNote
    const target = note && note.id === commandNoteId
      ? /^WITHDRAW #([1-9][0-9]*)$/u.exec(note.body)
      : null
    return target && fixtureState.current.gazetteWithdrawalCommandIds.has(commandNoteId)
      ? [{
          target_note_id: Number(target[1]),
          command_note_id: commandNoteId,
          withdrawn_at: note!.created_at,
        }]
      : []
  }
  if (q.includes('insert into notes')) {
    return [{
      id: 51,
      place_id: Number(params[0] ?? 2),
      author: String(params[4] ?? fixtureState.current.actorHandle),
      body: String(params[3] ?? 'hello from the square'),
      created_at: '2026-08-11T00:00:00.000Z',
    }]
  }
  return undefined
}
