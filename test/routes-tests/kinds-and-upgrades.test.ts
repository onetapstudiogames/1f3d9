import assert from 'node:assert/strict'
import { getRoutesTestContext } from '../helpers/routes-fixtures/context.ts'


export function registerKindsAndUpgradesTests(): void {
  const {
    CONTRACT_DRAWING,
    OTHER_SECRET,
    SELLER_WALLET,
    TREASURY,
    TX1,
    app,
    authHeaders,
    fixtureState,
    inserted,
    networkCalled,
    reset,
    setActor,
    sqlCalls,
    test,
  } = getRoutesTestContext()


  test('duplicate trait names fail before charging for a kind', async () => {
    reset({ scenario: 'duplicate kind traits', chainFrom: SELLER_WALLET, chainTo: TREASURY })
    const response = await app.request('/api/kind', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({
        name: 'double-glow', description: 'invalid', traits: ['glowing', 'glowing'], recipe: [],
      }),
    })
    assert.equal(response.status, 400)
    assert.match(JSON.stringify(await response.json()), /duplicate|unique/i)
    assert.equal(networkCalled('base-rpc.test') || networkCalled('facilitator.test'), false)
    assert.equal(inserted('kinds'), 0)
  })

  test('credential-shaped names and recipes fail before any public write or payment', async () => {
    const paidFields = { payer_wallet: SELLER_WALLET, fee_tx_hash: TX1 }
    const credentials = [
      `1f3d9_sk_${'a1'.repeat(24)}`,
      `1f3d9_at_${'b2'.repeat(32)}`,
      `1f3d9_rt_${'c3'.repeat(32)}`,
      `1f3d9_ac_${'d4'.repeat(32)}`,
    ]

    for (const leaked of credentials) {
      const cases = [
        ['/api/kind', 'POST', {
          name: leaked, description: 'safe', traits: [], recipe: [], ...paidFields,
        }],
        ['/api/kind', 'POST', {
          name: 'safe-kind', description: 'safe', traits: [leaked], recipe: [], ...paidFields,
        }],
        ['/api/kind', 'POST', {
          name: 'safe-kind', description: 'safe', traits: [],
          recipe: [{ kind: leaked, quantity: 1 }], ...paidFields,
        }],
        ['/api/kind/3/revise', 'POST', {
          description: 'safe', traits: [leaked], recipe: [], ...paidFields,
        }],
        ['/api/kind/3/revise', 'POST', {
          description: 'safe', traits: [], recipe: [{ kind: leaked, quantity: 1 }], ...paidFields,
        }],
        ['/api/trait', 'POST', { name: leaked, description: 'safe' }],
        ['/api/trait', 'POST', {
          name: 'safe-trait', description: 'safe',
          recipe: { use: [{ effect: 'label', target: 'actor', label: leaked }] },
        }],
        ['/api/trait', 'POST', {
          name: 'safe-trait', description: 'safe',
          recipe: { use: [{ effect: 'check_label', target: 'actor', label: leaked, then: [] }] },
        }],
        ['/api/place/2/laws', 'PUT', { traits: [leaked] }],
      ] as const

      for (const [path, method, body] of cases) {
        reset({ scenario: `credential write guard ${path}` })
        const response = await app.request(path, {
          method,
          headers: authHeaders(),
          body: JSON.stringify(body),
        })
        assert.equal(response.status, 400, `${path}: ${await response.clone().text()}`)
        assert.doesNotMatch(await response.text(), new RegExp(leaked, 'i'), path)
        assert.equal(networkCalled('base-rpc.test') || networkCalled('facilitator.test'), false, path)
        assert.equal(
          sqlCalls().some(call => (
            /\b(?:insert|update|delete)\b/i.test(call.query ?? '') &&
            /\b(?:kinds|kind_revisions|traits|place_law_changes|payment_uses|fees|events)\b/i
              .test(call.query ?? '')
          )),
          false,
          `${path}: ${JSON.stringify(sqlCalls())}`,
        )
      }
    }
  })

  test('an uncoined kind trait answers with the reason, not "internal"', async () => {
    reset({ scenario: 'uncoined kind trait', chainFrom: SELLER_WALLET, chainTo: TREASURY })
    const response = await app.request('/api/kind', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({
        name: 'erratum', description: 'corrects a claim', traits: ['never-coined'], recipe: [],
      }),
    })
    assert.equal(response.status, 400)
    const body = JSON.stringify(await response.json())
    assert.match(body, /unknown or duplicate trait/)
    assert.match(body, /POST \/api\/trait/)
    assert.doesNotMatch(body, /internal/)
  })

  test('an uncoined trait on kind revision answers with the reason, not "internal"', async () => {
    reset({ scenario: 'uncoined kind trait', chainFrom: SELLER_WALLET, chainTo: TREASURY })
    const response = await app.request('/api/kind/3/revise', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({
        description: 'corrected again', traits: ['never-coined'], recipe: [],
      }),
    })
    assert.equal(response.status, 400)
    const body = JSON.stringify(await response.json())
    assert.match(body, /unknown or duplicate trait/)
    assert.match(body, /POST \/api\/trait/)
    assert.doesNotMatch(body, /internal/)
  })

  test('things pin their birth revision and only their owner may voluntarily upgrade', async () => {
    reset({ scenario: 'thing revision', kindRevision: 1, openToThings: true })
    const made = await app.request('/api/thing', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ place_id: 2, name: 'porch lantern', body: 'warm light', kind_id: 3 }),
    })
    assert.equal(made.status, 201)
    const born = await made.json() as { thing: { birth_revision: number; current_revision: number } }
    assert.equal(born.thing.birth_revision, 1)
    assert.equal(born.thing.current_revision, 1)
    assert.ok(sqlCalls().some(call =>
      /things_today[\s\S]*things_today\s*\+\s*1/i.test(call.query ?? '') &&
      /insert\s+into\s+things/i.test(call.query ?? '')))

    fixtureState.current = { ...fixtureState.current, kindRevision: 2 }
    const edited = await app.request('/api/thing/41', {
      method: 'PATCH', headers: authHeaders(),
      body: JSON.stringify({ body: 'new words', birth_revision: 2 }),
    })
    assert.equal(edited.status, 400)

    const upgraded = await app.request('/api/thing/41/upgrade', { method: 'POST', headers: authHeaders() })
    assert.equal(upgraded.status, 200)
    const current = await upgraded.json() as { thing: { birth_revision: number; current_revision: number } }
    assert.equal(current.thing.birth_revision, 1)
    assert.equal(current.thing.current_revision, 2)
    const upgradeWrite = sqlCalls().find(call => /WITH\s+upgradeable/i.test(call.query ?? ''))
    assert.match(upgradeWrite?.query ?? '', /changed\.maker_id/i)
    assert.match(upgradeWrite?.query ?? '', /maker\.handle\s+AS\s+made_by/i)
    assert.match(upgradeWrite?.query ?? '', /changed\.owner_id\s+AS\s+current_owner_id/i)
    assert.match(upgradeWrite?.query ?? '', /current_owner\.handle\s+AS\s+current_owner/i)
    assert.match(upgradeWrite?.query ?? '', /JOIN\s+residents\s+maker\s+ON\s+maker\.id\s*=\s*changed\.maker_id/i)
    assert.match(upgradeWrite?.query ?? '', /JOIN\s+residents\s+current_owner\s+ON\s+current_owner\.id\s*=\s*changed\.owner_id/i)

    setActor(8, 'neighbor')
    const nonOwner = await app.request('/api/thing/41/upgrade', {
      method: 'POST', headers: authHeaders(OTHER_SECRET),
    })
    assert.equal(nonOwner.status, 403)

    reset({
      scenario: 'transferred thing upgrade keeps maker',
      actorId: 8,
      actorHandle: 'neighbor',
      thingOwnerId: 8,
      kindRevision: 2,
    })
    const transferred = await app.request('/api/thing/41/upgrade', {
      method: 'POST',
      headers: authHeaders(OTHER_SECRET),
    })
    assert.equal(transferred.status, 200)
    const transferredBody = await transferred.json() as { thing: Record<string, unknown> }
    assert.deepEqual({
      maker_id: transferredBody.thing.maker_id,
      made_by: transferredBody.thing.made_by,
      current_owner_id: transferredBody.thing.current_owner_id,
      current_owner: transferredBody.thing.current_owner,
      owner_id: transferredBody.thing.owner_id,
      owner: transferredBody.thing.owner,
    }, {
      maker_id: 7,
      made_by: 'tiny-lantern',
      current_owner_id: 8,
      current_owner: 'neighbor',
      owner_id: 8,
      owner: 'neighbor',
    })
  })

  test('thing upgrade reads an empty body once while required thing edit still rejects it', async () => {
    reset({
      scenario: 'thing revision',
      thingOwnerId: 7,
      thingKindId: 3,
      thingCurrentRevision: 1,
      kindRevision: 2,
    })
    const request = new Request('http://localhost/api/thing/41/upgrade', {
      method: 'POST',
      headers: authHeaders(),
    })
    const readBody = request.arrayBuffer.bind(request)
    let bodyReads = 0
    Object.defineProperty(request, 'arrayBuffer', {
      value: async () => {
        bodyReads += 1
        return await readBody()
      },
    })
    Object.defineProperty(request, 'clone', {
      value: () => {
        throw new Error('thing upgrade must not clone its request body')
      },
    })

    const response = await app.request(request)
    assert.equal(response.status, 200, await response.clone().text())
    assert.equal(bodyReads, 1)

    const requiredEdit = await app.request('/api/thing/41', {
      method: 'PATCH',
      headers: authHeaders(),
    })
    assert.equal(requiredEdit.status, 400)
    assert.deepEqual(await requiredEdit.json(), { error: 'body must be a JSON object' })
  })

  test('a typed thing owner deliberately selects base or a named variant on its pinned revision', async () => {
    const variants = [{
      name: 'ember',
      drawing: CONTRACT_DRAWING,
      drawing_state: 'complete',
      drawing_description: 'A low amber glow around the lantern base.',
    }]

    reset({
      scenario: 'thing selects named variant',
      thingOwnerId: 7,
      thingKindId: 3,
      kindDrawingVariants: variants,
      thingDrawingVariant: 'ember',
    })
    const selected = await app.request('/api/thing/41', {
      method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ drawing_variant_name: 'ember' }),
    })
    assert.equal(selected.status, 200, await selected.clone().text())
    const selectionWrite = sqlCalls().find(call => /update\s+things\s+set/iu.test(call.query ?? ''))
    assert.match(selectionWrite?.query ?? '', /drawing_variant/iu)
    assert.match(selectionWrite?.query ?? '', /kind_revisions/iu)
    assert.match(selectionWrite?.query ?? '', /IS\s+DISTINCT\s+FROM/iu)

    reset({
      scenario: 'thing selects kind base',
      thingOwnerId: 7,
      thingKindId: 3,
      kindDrawingVariants: variants,
      thingDrawingVariant: null,
    })
    const base = await app.request('/api/thing/41', {
      method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ drawing_variant_name: null }),
    })
    assert.equal(base.status, 200, await base.clone().text())
    assert.match(
      sqlCalls().find(call => /update\s+things\s+set/iu.test(call.query ?? ''))?.query ?? '',
      /drawing_variant/iu,
    )

    reset({
      scenario: 'thing selects missing variant',
      thingOwnerId: 7,
      thingKindId: 3,
      kindDrawingVariants: variants,
    })
    const missing = await app.request('/api/thing/41', {
      method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ drawing_variant_name: 'missing' }),
    })
    assert.equal(missing.status, 409, await missing.clone().text())
    assert.match((await missing.json() as { error: string }).error, /base|available|ember/iu)
  })

  test('thing upgrade preserves an offered variant name or refuses a silent fallback', async () => {
    const ember = {
      name: 'ember',
      drawing: CONTRACT_DRAWING,
      drawing_state: 'complete',
      drawing_description: 'A low amber glow around the lantern base.',
    }
    const dawn = {
      name: 'dawn',
      drawing: CONTRACT_DRAWING,
      drawing_state: 'complete',
      drawing_description: 'A bright line across the top of the lantern.',
    }

    reset({
      scenario: 'upgrade keeps offered variant',
      thingOwnerId: 7,
      thingKindId: 3,
      thingCurrentRevision: 1,
      thingDrawingVariant: 'ember',
      kindRevision: 2,
      kindDrawingVariants: [ember, dawn],
    })
    const preserved = await app.request('/api/thing/41/upgrade', {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({}),
    })
    assert.equal(preserved.status, 200, await preserved.clone().text())
    const preservedThing = (await preserved.json() as {
      thing: { current_revision: number; drawing_variant_name: string | null }
    }).thing
    assert.equal(preservedThing.current_revision, 2)
    assert.equal(preservedThing.drawing_variant_name, 'ember')
    const preservedWrite = sqlCalls().find(call => /WITH\s+upgradeable/iu.test(call.query ?? ''))
    assert.match(preservedWrite?.query ?? '', /drawing_variant/iu)
    assert.match(preservedWrite?.query ?? '', /drawing_variants/iu)

    reset({
      scenario: 'upgrade missing selected variant',
      thingOwnerId: 7,
      thingKindId: 3,
      thingCurrentRevision: 1,
      thingDrawingVariant: 'ember',
      kindRevision: 2,
      kindDrawingVariants: [dawn],
    })
    const blocked = await app.request('/api/thing/41/upgrade', {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({}),
    })
    assert.equal(blocked.status, 409, await blocked.clone().text())
    assert.match((await blocked.json() as { error: string }).error, /choose.*base|available.*variant/iu)
    assert.equal(sqlCalls().some(call => /insert\s+into\s+events/iu.test(call.query ?? '')), false)

    reset({
      scenario: 'upgrade deliberately chooses base',
      thingOwnerId: 7,
      thingKindId: 3,
      thingCurrentRevision: 1,
      thingDrawingVariant: null,
      kindRevision: 2,
      kindDrawingVariants: [dawn],
    })
    const choseBase = await app.request('/api/thing/41/upgrade', {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ drawing_variant_name: null }),
    })
    assert.equal(choseBase.status, 200, await choseBase.clone().text())
    assert.match(
      sqlCalls().find(call => /WITH\s+upgradeable/iu.test(call.query ?? ''))?.query ?? '',
      /drawing_variant/iu,
    )

    reset({
      scenario: 'upgrade deliberately chooses target variant',
      thingOwnerId: 7,
      thingKindId: 3,
      thingCurrentRevision: 1,
      thingDrawingVariant: 'dawn',
      kindRevision: 2,
      kindDrawingVariants: [dawn],
    })
    const choseDawn = await app.request('/api/thing/41/upgrade', {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ drawing_variant_name: 'dawn' }),
    })
    assert.equal(choseDawn.status, 200, await choseDawn.clone().text())
    const choseDawnThing = (await choseDawn.json() as {
      thing: { current_revision: number; drawing_variant_name: string | null }
    }).thing
    assert.equal(choseDawnThing.current_revision, 2)
    assert.equal(choseDawnThing.drawing_variant_name, 'dawn')
  })

  test('an exact thing upgrade retry is a no-op with no duplicate event', async () => {
    const ember = {
      name: 'ember',
      drawing: CONTRACT_DRAWING,
      drawing_state: 'complete',
      drawing_description: 'A low amber glow around the lantern base.',
    }
    reset({
      scenario: 'exact upgrade retry',
      thingOwnerId: 7,
      thingKindId: 3,
      thingCurrentRevision: 2,
      thingDrawingVariant: 'ember',
      kindRevision: 2,
      kindDrawingVariants: [ember],
    })

    const retry = await app.request('/api/thing/41/upgrade', {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({}),
    })
    assert.equal(retry.status, 200, await retry.clone().text())
    const write = sqlCalls().find(call => /WITH\s+upgradeable/iu.test(call.query ?? ''))
    assert.match(write?.query ?? '', /IS\s+DISTINCT\s+FROM/iu)
    assert.match(write?.query ?? '', /INSERT\s+INTO\s+events[\s\S]*FROM\s+changed/iu)
    assert.match(write?.query ?? '', /WHERE\s+NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+changed\s*\)/iu)
  })

  test('thing upgrade turns only a busy kind lock into a retryable conflict', async () => {
    reset({
      scenario: 'thing upgrade kind lock',
      thingOwnerId: 7,
      thingKindId: 3,
      thingCurrentRevision: 1,
      kindRevision: 2,
    })

    const response = await app.request('/api/thing/41/upgrade', {
      method: 'POST',
      headers: authHeaders(),
    })
    assert.equal(response.status, 409, await response.clone().text())
    assert.deepEqual(await response.json(), {
      error: 'another action is changing this thing or kind; retry this thing upgrade',
    })
    const lockedUpgrade = sqlCalls().find(call => /WITH\s+upgradeable/iu.test(call.query ?? ''))?.query ?? ''
    assert.match(lockedUpgrade, /FOR\s+UPDATE\s+OF\s+thing\s*,\s*kind\s+NOWAIT/iu)
    assert.match(lockedUpgrade, /thing\.current_revision\s*=\s*\$\d+/iu)
    assert.match(lockedUpgrade, /thing\.drawing_state\s+IS\s+NOT\s+DISTINCT\s+FROM\s*\$\d+/iu)
    assert.match(lockedUpgrade, /thing\.drawing_variant_name\s+IS\s+NOT\s+DISTINCT\s+FROM\s*\$\d+/iu)
  })
}
