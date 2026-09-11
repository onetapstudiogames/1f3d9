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

export function respondToDatabaseStage4(
  query: string,
  params: unknown[],
  q: string,
): Record<string, unknown>[] | undefined {


  // link_kind_revision_traits refuses a trait nobody has coined yet.
  if (fixtureState.current.scenario === 'uncoined kind trait' &&
      (/insert into kinds/.test(q) || /insert into kind_revisions/.test(q))) {
    throw Object.assign(
      new Error('kind revision names an unknown or duplicate trait'),
      { code: '23503' },
    )
  }

  if (q.includes('/* note-action:quota */')) {
    return [{ notes_today: fixtureState.current.quota.notes ? 0 : 50 }]
  }
  if (q.includes('where secret_hash')) return fixtureState.current.authValid ? [residentRow()] : []
  if (q.includes('/* crafting:commit */')) return [thingRow()]
  if (q.includes('insert into resident_presence') && !q.includes('insert into places')) {
    if (q.includes('cross join places place')) {
      const destination = Number(params[1])
      fixtureState.current = { ...fixtureState.current, currentPlaceId: destination }
      return [{ resident_id: fixtureState.current.actorId }]
    }
    const requestedHome = params.find(value => Number(value) === 2 || Number(value) === 3)
    if (q.includes('where owned.id') && requestedHome != null) {
      const home = Number(requestedHome)
      if (home !== 3 && fixtureState.current.placeOwnerId !== fixtureState.current.actorId) return []
      fixtureState.current = { ...fixtureState.current, homePlaceId: home, currentPlaceId: fixtureState.current.currentPlaceId ?? home }
    }
    return [{
      resident_id: fixtureState.current.actorId,
      current_place_id: fixtureState.current.currentPlaceId,
      home_place_id: fixtureState.current.homePlaceId,
      updated_at: '2026-08-11T00:00:00.000Z',
    }]
  }
  if (q.includes('with usable_home as materialized')) {
    fixtureState.current = { ...fixtureState.current, currentPlaceId: fixtureState.current.homePlaceId }
    return [{
      resident_id: fixtureState.current.actorId,
      current_place_id: fixtureState.current.currentPlaceId,
      home_place_id: fixtureState.current.homePlaceId,
      updated_at: '2026-08-11T00:05:00.000Z',
    }]
  }
  if (q.includes('society:place-gift-transfer')) {
    if (fixtureState.current.scenario === 'nested gift owner blocker') {
      return [{ id: null, blocker_id: 17, blocker_reason: 'owner', home_cleared: false }]
    }
    if (fixtureState.current.scenario === 'nested gift offer blocker') {
      return [{ id: null, blocker_id: 18, blocker_reason: 'open_offer', home_cleared: false }]
    }
    return [{ id: 91, created_at: '2026-08-11T00:00:00.000Z', home_cleared: true }]
  }
  if (q.includes('from resident_presence')) return [{
    resident_id: fixtureState.current.actorId,
    current_place_id: fixtureState.current.currentPlaceId,
    home_place_id: fixtureState.current.homePlaceId,
    updated_at: '2026-08-11T00:00:00.000Z',
  }]
  if (q.includes('update resident_presence')) {
    const destination = q.includes('home_place_id')
      ? fixtureState.current.homePlaceId
      : Number(params[0] ?? fixtureState.current.currentPlaceId)
    fixtureState.current = { ...fixtureState.current, currentPlaceId: destination }
    return [{
      resident_id: fixtureState.current.actorId,
      current_place_id: fixtureState.current.currentPlaceId,
      home_place_id: fixtureState.current.homePlaceId,
      updated_at: '2026-08-11T00:05:00.000Z',
    }]
  }
  if (q.includes('insert into action_runs')) return [{ id: 101 }]
  if (q.includes('as place_pending')) return [{ place_pending: 0, actor_pending: 0 }]
  if (q.includes('pg_advisory_xact_lock')) return []
  if (q.includes('from active_blocks')) return fixtureState.current.actionBlocked ? [{
    blocked: true,
    source_trait_id: 4,
    trait_name: fixtureState.current.lawTraitName,
    source_place_id: 2,
    source_thing_id: null,
    law_source_matches_trait: true,
  }] : []
  if (q.includes('insert into action_resolutions')) {
    fixtureState.current = { ...fixtureState.current, actionResolved: true }
    return [{ id: 201 }]
  }
  if (q.includes('with recursive ancestry') && q.includes('update things set withdrawn_at')) {
    const target = Number(params.find(value => [41, 42].includes(Number(value))) ?? 41)
    if (target === 42 && !fixtureState.current.targetThingWithdrawn) {
      fixtureState.current = { ...fixtureState.current, targetThingWithdrawn: true }
      return [{ id: 42 }]
    }
    return []
  }
  if (q.includes('with recursive ancestry') && q.includes('ranked_changes')) {
    return fixtureState.current.placeLawNames.map((name, position) => ({
      trait_id: 4 + position,
      name,
      recipe: fixtureState.current.lawTraitRecipe,
      source_place_id: 2,
      position,
    }))
  }
  if (q.includes('from pending_effects pending')) {
    if (fixtureState.current.scheduledLabelAt == null || fixtureState.current.scheduledLabelAt > Date.now() || fixtureState.current.pendingResolved) return []
    return [{
      id: 501,
      action_id: 101,
      parent_effect_id: null,
      place_id: 2,
      actor_id: fixtureState.current.actorId,
      source_trait_id: 4,
      source_thing_id: 41,
      target_type: 'place',
      target_id: 2,
      destination_place_id: null,
      recipient_id: null,
      payload: {
        effects: [{ effect: 'label', target: 'place', label: 'echo' }],
        repeat_remaining: 0,
        repeat_seconds: 60,
        law_authority: null,
      },
      due_at: new Date(fixtureState.current.scheduledLabelAt).toISOString(),
      generation: 0,
    }]
  }
  if (q.includes('insert into pending_effects')) {
    fixtureState.current = { ...fixtureState.current, scheduledLabelAt: Date.now() + 60_000 }
    return [{ id: 301 }]
  }
  if (q.includes('insert into effect_resolutions')) {
    fixtureState.current = { ...fixtureState.current, pendingResolved: true }
    return [{ id: 701 }]
  }
  if (q.includes('select distinct label') && q.includes('from active_labels')) {
    const labels = q.includes("target_type = 'resident'") ? fixtureState.current.actorLabels : fixtureState.current.placeLabels
    return labels.map(label => ({ label }))
  }
  if (q.includes('from active_labels') && q.includes('select exists')) {
    const targetType = String(params[0] ?? '')
    const label = String(params[2] ?? '')
    const labels = targetType === 'resident' ? fixtureState.current.actorLabels : fixtureState.current.placeLabels
    return [{ present: labels.includes(label) }]
  }
  if (q.includes('insert into active_labels')) {
    const targetType = String(params[0] ?? '')
    const label = String(params[2] ?? '')
    if (targetType === 'resident') fixtureState.current = { ...fixtureState.current, actorLabels: [...fixtureState.current.actorLabels, label] }
    if (targetType === 'place') fixtureState.current = { ...fixtureState.current, placeLabels: [...fixtureState.current.placeLabels, label] }
    return [{ id: 301 }]
  }
  if (q.includes('insert into active_blocks')) {
    fixtureState.current = { ...fixtureState.current, actionBlocked: true }
    return [{ id: 302 }]
  }
  if (q.includes('select exists') && (
    q.includes('from residents') || q.includes('from places')
      || q.includes('from kinds') || q.includes('from things')
  )) return [{ exists: Number(params[0]) !== 2_147_483_647 }]
  if (q.includes('from places place') && q.includes('place.id = any')) {
    return [
      selectedPlacePermission(placeRow(2, 1), q),
      selectedPlacePermission(placeRow(3, 2), q),
    ]
  }
  if (q.includes('select id, parent_id, retired_at from places') && q.includes('any')) {
    return [
      { ...placeRow(2, 1), retired_at: null },
      { ...placeRow(3, 2), retired_at: null },
    ]
  }
  if (q.includes('from labels')) {
    const targetType = String(params[0] ?? '')
    const names = targetType === 'resident'
      ? fixtureState.current.actorLabels
      : targetType === 'place'
        ? fixtureState.current.placeLabels
        : []
    return names.map(name => ({ name }))
  }
  if (q.includes('insert into labels')) {
    const targetType = String(params[0] ?? '')
    const label = String(params[2] ?? '').toLowerCase()
    if (targetType === 'resident') {
      fixtureState.current = { ...fixtureState.current, actorLabels: [...fixtureState.current.actorLabels, label] }
    } else if (targetType === 'place') {
      fixtureState.current = { ...fixtureState.current, placeLabels: [...fixtureState.current.placeLabels, label] }
    }
    return []
  }
  if (q.includes('from place_laws law') && q.includes('trait.recipe')) {
    return fixtureState.current.placeLawNames.length && fixtureState.current.lawTraitRecipe
      ? [{ recipe: fixtureState.current.lawTraitRecipe }]
      : []
  }
  if (q.includes('from place_laws law') && q.includes('trait.name')) {
    return fixtureState.current.placeLawNames.map(name => ({ name }))
  }
  if (q.includes('select owner_id from places where id =')) return [{ owner_id: fixtureState.current.placeOwnerId }]
  if (q.includes('delete from place_laws')) {
    fixtureState.current = { ...fixtureState.current, placeLawNames: [] }
    return []
  }
  if (q.includes('insert into place_laws')) {
    const traitId = Number(params[1] ?? 0)
    const name = traitId === 4 ? fixtureState.current.lawTraitName : fixtureState.current.lawTraitName
    fixtureState.current = { ...fixtureState.current, placeLawNames: [...fixtureState.current.placeLawNames, name] }
    return []
  }
  if (q.includes('insert into place_law_changes')) {
    const encoded = params.find(value => typeof value === 'string' && value.startsWith('[{'))
    const laws = typeof encoded === 'string'
      ? JSON.parse(encoded) as Array<{ id: number; name: string; position: number }>
      : []
    fixtureState.current = { ...fixtureState.current, placeLawNames: laws.map(law => law.name) }
    return [{ id: 2, laws }]
  }
  if (q.includes('select id, name from traits where name = any')) {
    const raw = params[0]
    let names: string[]
    if (Array.isArray(raw)) {
      names = raw.map(String)
    } else if (typeof raw === 'string' && raw.startsWith('[')) {
      names = (JSON.parse(raw) as unknown[]).map(String)
    } else {
      names = String(raw ?? '').replace(/^\{|\}$/g, '').split(',')
        .map(name => name.replace(/^"|"$/g, ''))
        .filter(Boolean)
    }
    return names.map((name, index) => ({ id: 4 + index, name }))
  }
  if (q.includes('from resident_action_blocks')) {
    return fixtureState.current.actionBlocked ? [{ id: 1 }] : []
  }
  if (q.includes('insert into resident_action_blocks')) {
    fixtureState.current = { ...fixtureState.current, actionBlocked: true }
    return []
  }
  if (q.includes('insert into scheduled_effects')) {
    const seconds = Number(params[6] ?? 0)
    fixtureState.current = { ...fixtureState.current, scheduledLabelAt: Date.now() + seconds * 1000 }
    return []
  }
  if (q.includes('from scheduled_effects')) {
    if (fixtureState.current.scheduledLabelAt == null || fixtureState.current.scheduledLabelAt > Date.now()) return []
    if (!fixtureState.current.placeLabels.includes('echo')) {
      fixtureState.current = { ...fixtureState.current, placeLabels: [...fixtureState.current.placeLabels, 'echo'] }
    }
    return [{
      id: 301,
      actor_id: fixtureState.current.actorId,
      source_thing_id: 41,
      target_type: 'place',
      target_id: 2,
      recipe: [{ effect: 'label', target: 'place', label: 'echo' }],
      repeat_seconds: null,
      generations_left: 1,
    }]
  }
  if (q.includes('delete from scheduled_effects')) {
    fixtureState.current = { ...fixtureState.current, scheduledLabelAt: null, placeLabels: [...fixtureState.current.placeLabels, 'echo'] }
    return []
  }
  if (q.includes('from moderation_states')) return []
  if (q.includes('insert into moderation_states')) {
    if (q.includes('removed_at')) {
      fixtureState.current = { ...fixtureState.current, noteRemoved: !q.includes('set removed_at = null') }
    }
    if (q.includes('pinned_at')) {
      fixtureState.current = { ...fixtureState.current, notePinned: !q.includes('set pinned_at = null') }
    }
    return []
  }
  if (q.includes('insert into moderation_actions')) {
    const targetId = Number(params[0])
    const targetType = String(params[1])
    const action = String(params[2]) as 'remove' | 'restore'
    const reason = String(params[4])
    if (targetType === 'note') {
      fixtureState.current = { ...fixtureState.current, noteRemoved: action === 'remove' }
    }
    return [{
      id: 401,
      target_type: targetType,
      target_id: targetId,
      action,
      actor_id: fixtureState.current.actorId,
      reason,
      created_at: '2026-08-11T00:04:00.000Z',
    }]
  }
  if (fixtureState.current.scenario === 'remaining pagination' && q.includes('/* public:moderation */')) {
    const all = remainingPaginationRows('moderation')
    const totalTextBytes = all.reduce(
      (total, row) => total + Buffer.byteLength(
        String((row as Record<string, unknown>).reason ?? ''),
        'utf8',
      ),
      0,
    )
    const page = descendingPage(all, params[0], params[1])
    return page.length > 0
      ? page.map(row => ({ ...row, total_items: all.length, total_text_bytes: totalTextBytes }))
      : [{ id: null, total_items: all.length, total_text_bytes: totalTextBytes }]
  }
  if (q.includes('/* public:moderation */')) {
    return [{ id: null, total_items: 0, total_text_bytes: 0 }]
  }
  if (
    q.includes('from moderation_actions')
    && !q.includes('update places set')
    && !q.includes('/* public:window-directory */')
    && !q.includes('as has_drawing')
  ) {
    const targetType = String(params.find(value => (
      value === 'place' || value === 'thing' || value === 'kind' || value === 'trait'
        || value === 'note' || value === 'agreement'
    )) ?? '')
    const removedIds = targetType === 'place'
      ? fixtureState.current.moderatedPlaceIds
      : targetType === 'kind' ? fixtureState.current.moderatedKindIds
      : targetType === 'trait' ? fixtureState.current.moderatedTraitIds : []
    const removedNames = targetType === 'kind'
      ? fixtureState.current.moderatedKindNames
      : targetType === 'trait' ? fixtureState.current.moderatedTraitNames : []
    if (q.includes('join kinds named') || q.includes('join traits named')) {
      return removedNames.map((name, index) => ({
        name,
        target_id: 100 + index,
        action: 'remove',
        reason: 'illegal nested text',
        created_at: '2026-08-11T00:04:00.000Z',
      }))
    }
    if (removedIds.length > 0) {
      return removedIds.map(target_id => ({
        target_id,
        action: 'remove',
        reason: 'illegal nested text',
        created_at: '2026-08-11T00:04:00.000Z',
      }))
    }
    if (targetType === 'note' && fixtureState.current.noteRemoved) {
      return [{
        target_id: 51,
        action: 'remove',
        reason: 'illegal content',
        created_at: '2026-08-11T00:04:00.000Z',
      }]
    }
    return []
  }
  if (q.includes('insert into anonymous_flag_limits')) {
    const callerKey = String(params[0])
    const hourlyLimit = Number(params[1])
    const used = fixtureState.current.flagSlotsUsed[callerKey] ?? 0
    if (used >= hourlyLimit) return []
    fixtureState.current = { ...fixtureState.current, flagSlotsUsed: { ...fixtureState.current.flagSlotsUsed, [callerKey]: used + 1 } }
    return [{ used: used + 1 }]
  }
  if (q.includes('from reg_log')) return [{ ip: 0, all: 0 }]
  if (q.includes('insert into residents')) return [{ id: 7, handle: 'tiny-lantern' }]
  if (q.includes("kind = 'rotate'") || q.includes('kind=$') && q.includes('rotate')) return [{ n: 0 }]
  if (q.includes('update residents set secret_hash')) return [{ id: fixtureState.current.actorId }]
  if (q.includes('update residents set current_place_id')) {
    if (q.includes('from destination')) {
      fixtureState.current = { ...fixtureState.current, currentPlaceId: fixtureState.current.homePlaceId }
      return [{ current_place_id: fixtureState.current.currentPlaceId }]
    }
    const placeId = Number(params[0] ?? 0)
    fixtureState.current = { ...fixtureState.current, currentPlaceId: placeId }
    return [{ current_place_id: placeId }]
  }
  if (q.includes('select current_place_id') && q.includes('from residents')) {
    return [{ current_place_id: fixtureState.current.currentPlaceId }]
  }
  if (q.includes('select coalesce(home_place_id')) return [{ current_place_id: fixtureState.current.homePlaceId }]

  if (q.includes('things_today = things_today + 1') && q.includes('insert into things'))
    return fixtureState.current.quota.things ? [thingRow()] : []
  if (q.includes('things_today = things_today + 1')) return fixtureState.current.quota.things ? [{ id: fixtureState.current.actorId }] : []
  if (q.includes('notes_today = notes_today + 1') && q.includes('insert into notes')) {
    if (!fixtureState.current.quota.notes) return []
    const requestedPlaceId = Number(params[2] ?? fixtureState.current.currentPlaceId ?? 2)
    if (requestedPlaceId === 454 && !fixtureState.current.gazetteActivated) {
      return [{
        id: null,
        place_exists: true,
        place_permits_notes: true,
        gazette_activated: false,
        note_quota_spent: false,
      }]
    }
    const note = {
      id: fixtureState.current.nextNoteId,
      place_id: requestedPlaceId,
      author_id: fixtureState.current.actorId,
      author: String(params.at(-1) ?? fixtureState.current.actorHandle),
      body: String(params.at(-3) ?? 'hello from the square'),
      created_at: '2026-08-11T00:00:00.000Z',
    }
    if (
      requestedPlaceId === 454
      && fixtureState.current.gazetteWithdrawalsOpen
      && /^WITHDRAW\s*#/u.test(note.body)
      && !/^WITHDRAW #[1-9][0-9]*$/u.test(note.body)
    ) {
      throw Object.assign(new Error('Gazette withdrawal must be exactly WITHDRAW #<your-note-id>'), {
        code: '23514',
        constraint: 'gazette_withdrawal_command_invalid',
      })
    }
    const gazetteWithdrawalCommandIds = fixtureState.current.gazetteWithdrawalsOpen
      && /^WITHDRAW #[1-9][0-9]*$/u.test(note.body)
      ? new Set([...fixtureState.current.gazetteWithdrawalCommandIds, note.id])
      : fixtureState.current.gazetteWithdrawalCommandIds
    fixtureState.current = {
      ...fixtureState.current,
      recentNote: note,
      gazetteWithdrawalCommandIds,
      nextNoteId: fixtureState.current.nextNoteId + 1,
    }
    return [note]
  }
  if (q.includes('notes_today = notes_today + 1')) return fixtureState.current.quota.notes ? [{ id: fixtureState.current.actorId }] : []
  return undefined
}
