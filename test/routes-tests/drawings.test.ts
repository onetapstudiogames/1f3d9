import assert from 'node:assert/strict'
import { getRoutesTestContext } from '../helpers/routes-fixtures/context.ts'


export function registerDrawingsTests(): void {
  const {
    CONTRACT_DRAWING,
    CONTRACT_DRAWING_DESCRIPTION,
    SELLER_WALLET,
    TREASURY,
    X_PAYMENT,
    app,
    authHeaders,
    fixtureState,
    inserted,
    networkCalled,
    reset,
    sqlCalls,
    test,
  } = getRoutesTestContext()


  test('traits are globally named, free, and mechanical only when an inert recipe is present', async () => {
    reset({ scenario: 'traits', traitHasRecipe: true })
    const created = await app.request('/api/trait', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({
        name: 'glowing', description: 'gives off light',
        recipe: { use: [{ effect: 'label', target: 'source', label: 'lit' }] },
      }),
    })
    assert.equal(created.status, 201)
    const body = await created.json() as { trait: { name: string; mechanical: boolean } }
    assert.equal(body.trait.name, 'glowing')
    assert.equal(body.trait.mechanical, true)
    assert.equal(networkCalled('base-rpc.test') || networkCalled('facilitator.test'), false)

    const listed = await app.request('/api/traits')
    assert.equal(listed.status, 200)
  })

  test('kind revision is paid but never rewrites existing things', async () => {
    reset({
      scenario: 'kind revision', chainFrom: SELLER_WALLET, chainTo: TREASURY,
      facilitatorVerify: true, facilitatorSettle: true,
    })
    const revised = await app.request('/api/kind/3/revise', {
      method: 'POST', headers: { ...authHeaders(), 'X-PAYMENT': X_PAYMENT },
      body: JSON.stringify({
        description: 'a small dependable light', traits: ['glowing'], recipe: [],
      }),
    })
    assert.equal(revised.status, 200)
    const body = await revised.json() as { kind: { revision: number } }
    assert.equal(body.kind.revision, 2)
    assert.equal(sqlCalls().some(call => /update\s+things/i.test(call.query ?? '')), false)
  })

  test('place drawings atomically require the owner-selected state and paired description', async () => {
    reset({ scenario: 'place drawing', placeOwnerId: 7 })
    const place = await app.request('/api/place/2', {
      method: 'PATCH', headers: authHeaders(), body: JSON.stringify({
        drawing: CONTRACT_DRAWING,
        drawing_state: 'complete',
        drawing_description: 'The word REFUSE is painted on a complete warning sign.',
      }),
    })
    assert.equal(place.status, 200, await place.clone().text())
    const placeWrite = sqlCalls().find(call => /update\s+places\s+set/iu.test(call.query ?? ''))
    assert.match(placeWrite?.query ?? '', /drawing_state/iu)
    assert.match(placeWrite?.query ?? '', /drawing_description/iu)
    assert.match(placeWrite?.query ?? '', /drawing_revisions/iu)
    assert.match(placeWrite?.query ?? '', /IS\s+DISTINCT\s+FROM/iu)
    assert.equal(placeWrite?.params?.includes('complete'), true)
    assert.equal(
      placeWrite?.params?.includes('The word REFUSE is painted on a complete warning sign.'),
      true,
    )

    reset({ scenario: 'place refused drawing', placeOwnerId: 7 })
    const refused = await app.request('/api/place/2', {
      method: 'PATCH', headers: authHeaders(), body: JSON.stringify({
        drawing: 'REFUSE',
        drawing_description: 'I decline to draw this place.',
      }),
    })
    assert.equal(refused.status, 200, await refused.clone().text())
    const refusalWrite = sqlCalls().find(call => /update\s+places\s+set/iu.test(call.query ?? ''))
    assert.equal(refusalWrite?.params?.includes('refused'), true)
    assert.equal(refusalWrite?.params?.includes('REFUSE'), false)
    assert.equal(refusalWrite?.params?.includes('I decline to draw this place.'), true)

    fixtureState.current = { ...fixtureState.current, calls: [] }
    const cleared = await app.request('/api/place/2', {
      method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ drawing: null }),
    })
    assert.equal(cleared.status, 200, await cleared.clone().text())
    const clearWrite = sqlCalls().find(call => /update\s+places\s+set/iu.test(call.query ?? ''))
    assert.match(clearWrite?.query ?? '', /drawing_revisions/iu)
  })

  test('thing drawing rules separate typed inheritance from untyped owner artwork', async () => {
    reset({ scenario: 'typed thing direct drawing', thingOwnerId: 7, thingKindId: 3 })
    const typedPixels = await app.request('/api/thing/41', {
      method: 'PATCH', headers: authHeaders(), body: JSON.stringify({
        drawing: CONTRACT_DRAWING,
        drawing_state: 'complete',
        drawing_description: CONTRACT_DRAWING_DESCRIPTION,
      }),
    })
    assert.equal(typedPixels.status, 400, await typedPixels.clone().text())
    assert.match((await typedPixels.json() as { error: string }).error, /typed|kind|inherit/iu)
    assert.equal(sqlCalls().some(call => /update\s+things\s+set/iu.test(call.query ?? '')), false)

    reset({ scenario: 'typed thing refusal', thingOwnerId: 7, thingKindId: 3 })
    const refused = await app.request('/api/thing/41', {
      method: 'PATCH', headers: authHeaders(), body: JSON.stringify({
        drawing: 'REFUSE',
        drawing_description: 'I refuse to show the inherited lantern drawing.',
      }),
    })
    assert.equal(refused.status, 200, await refused.clone().text())
    assert.match(
      sqlCalls().find(call => /update\s+things\s+set/iu.test(call.query ?? ''))?.query ?? '',
      /drawing_revisions/iu,
    )

    fixtureState.current = { ...fixtureState.current, calls: [] }
    const inheritedAgain = await app.request('/api/thing/41', {
      method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ drawing: null }),
    })
    assert.equal(inheritedAgain.status, 200, await inheritedAgain.clone().text())

    reset({ scenario: 'untyped thing drawing', thingOwnerId: 7, thingKindId: null })
    const untypedPixels = await app.request('/api/thing/41', {
      method: 'PATCH', headers: authHeaders(), body: JSON.stringify({
        drawing: CONTRACT_DRAWING,
        drawing_state: 'in_progress',
        drawing_description: 'The lantern body is drawn; the handle is still unfinished.',
      }),
    })
    assert.equal(untypedPixels.status, 200, await untypedPixels.clone().text())
    const untypedWrite = sqlCalls().find(call => /update\s+things\s+set/iu.test(call.query ?? ''))
    assert.match(untypedWrite?.query ?? '', /drawing_state/iu)
    assert.match(untypedWrite?.query ?? '', /drawing_description/iu)
    assert.match(untypedWrite?.query ?? '', /drawing_revisions/iu)
  })

  test('paid kind requests store owner-authored base drawings and bounded named variants', async () => {
    const variants = [
      {
        name: 'ember',
        drawing: CONTRACT_DRAWING,
        drawing_state: 'complete',
        drawing_description: 'A low amber glow around the lantern base.',
      },
      {
        name: 'dawn',
        drawing: {
          palette: ['#f0c95f'],
          indices: Array.from({ length: 64 }, (_, index) => index < 8 ? 0 : null),
        },
        drawing_state: 'in_progress',
        drawing_description: 'The dawn stripe is placed; the frame is unfinished.',
      },
    ]

    reset({
      scenario: 'kind drawing', chainFrom: SELLER_WALLET, chainTo: TREASURY,
      facilitatorVerify: true, facilitatorSettle: true,
    })
    const kind = await app.request('/api/kind', {
      method: 'POST', headers: { ...authHeaders(), 'X-PAYMENT': X_PAYMENT },
      body: JSON.stringify({
        name: 'painted-lantern', description: 'a drawn kind', traits: [], recipe: [],
        drawing: CONTRACT_DRAWING,
        drawing_state: 'complete',
        drawing_description: CONTRACT_DRAWING_DESCRIPTION,
        drawing_variants: variants,
      }),
    })
    assert.equal(kind.status, 201, await kind.clone().text())
    const inventionAttempt = [...fixtureState.current.paymentAttempts.values()]
      .find(attempt => attempt.operation === 'kind_invention')
    assert.deepEqual(inventionAttempt?.request_json?.drawing, CONTRACT_DRAWING)
    assert.equal(inventionAttempt?.request_json?.drawing_state, 'complete')
    assert.equal(inventionAttempt?.request_json?.drawing_description, CONTRACT_DRAWING_DESCRIPTION)
    assert.deepEqual(inventionAttempt?.request_json?.drawing_variants, variants)

    reset({
      scenario: 'kind drawing revision', chainFrom: SELLER_WALLET, chainTo: TREASURY,
      facilitatorVerify: true, facilitatorSettle: true,
      kindDrawing: CONTRACT_DRAWING,
      kindDrawingState: 'complete',
      kindDrawingDescription: CONTRACT_DRAWING_DESCRIPTION,
      kindDrawingVariants: variants,
    })
    const revised = await app.request('/api/kind/3/revise', {
      method: 'POST', headers: { ...authHeaders(), 'X-PAYMENT': X_PAYMENT },
      body: JSON.stringify({ description: 'same art, newly revised words' }),
    })
    assert.equal(revised.status, 200, await revised.clone().text())
    const revisionAttempt = [...fixtureState.current.paymentAttempts.values()]
      .find(attempt => attempt.operation === 'kind_revision')
    assert.deepEqual(revisionAttempt?.request_json?.drawing, CONTRACT_DRAWING)
    assert.equal(revisionAttempt?.request_json?.drawing_state, 'complete')
    assert.equal(revisionAttempt?.request_json?.drawing_description, CONTRACT_DRAWING_DESCRIPTION)
    assert.deepEqual(revisionAttempt?.request_json?.drawing_variants, variants)

    reset({
      scenario: 'kind variant removal revision', chainFrom: SELLER_WALLET, chainTo: TREASURY,
      facilitatorVerify: true, facilitatorSettle: true,
      kindDrawing: CONTRACT_DRAWING,
      kindDrawingState: 'complete',
      kindDrawingDescription: CONTRACT_DRAWING_DESCRIPTION,
      kindDrawingVariants: variants,
    })
    const removed = await app.request('/api/kind/3/revise', {
      method: 'POST', headers: { ...authHeaders(), 'X-PAYMENT': X_PAYMENT },
      body: JSON.stringify({ drawing_variants: [] }),
    })
    assert.equal(removed.status, 200, await removed.clone().text())
    const removalAttempt = [...fixtureState.current.paymentAttempts.values()]
      .find(attempt => attempt.operation === 'kind_revision')
    assert.deepEqual(removalAttempt?.request_json?.drawing, CONTRACT_DRAWING)
    assert.equal(removalAttempt?.request_json?.drawing_state, 'complete')
    assert.equal(removalAttempt?.request_json?.drawing_description, CONTRACT_DRAWING_DESCRIPTION)
    assert.deepEqual(removalAttempt?.request_json?.drawing_variants, [])
  })

  test('omitted empty kind drawings retain the pre-drawing canonical payment shape', async () => {
    reset({
      scenario: 'legacy-shaped kind invention', chainFrom: SELLER_WALLET, chainTo: TREASURY,
      facilitatorVerify: true, facilitatorSettle: true,
    })
    const invented = await app.request('/api/kind', {
      method: 'POST', headers: { ...authHeaders(), 'X-PAYMENT': X_PAYMENT },
      body: JSON.stringify({
        name: 'legacy-shaped-lantern', description: 'no drawing supplied', traits: [], recipe: [],
      }),
    })
    assert.equal(invented.status, 201, await invented.clone().text())
    const inventionAttempt = [...fixtureState.current.paymentAttempts.values()]
      .find(attempt => attempt.operation === 'kind_invention')
    assert.equal(Object.hasOwn(inventionAttempt?.request_json ?? {}, 'drawing'), false)

    reset({
      scenario: 'legacy-shaped kind revision', chainFrom: SELLER_WALLET, chainTo: TREASURY,
      facilitatorVerify: true, facilitatorSettle: true,
    })
    const revised = await app.request('/api/kind/3/revise', {
      method: 'POST', headers: { ...authHeaders(), 'X-PAYMENT': X_PAYMENT },
      body: JSON.stringify({ description: 'still no drawing supplied' }),
    })
    assert.equal(revised.status, 200, await revised.clone().text())
    const revisionAttempt = [...fixtureState.current.paymentAttempts.values()]
      .find(attempt => attempt.operation === 'kind_revision')
    assert.equal(Object.hasOwn(revisionAttempt?.request_json ?? {}, 'drawing'), false)
  })

  test('drawing write validation is caller-worded and runs before owner writes or payment', async () => {
    const invalid = {
      palette: ['red'],
      indices: Array.from({ length: 64 }, () => 0),
    }
    const cases = [
      ['/api/place/2', 'PATCH'],
      ['/api/thing/41', 'PATCH'],
      ['/api/kind', 'POST'],
      ['/api/kind/3/revise', 'POST'],
    ] as const

    for (const [path, method] of cases) {
      reset({ scenario: `invalid drawing ${path}`, placeOwnerId: 7, thingOwnerId: 7 })
      const response = await app.request(path, {
        method,
        headers: authHeaders(),
        body: JSON.stringify(path === '/api/kind'
          ? {
              name: 'invalid-drawing', traits: [], recipe: [], drawing: invalid,
              drawing_state: 'complete', drawing_description: 'Invalid colour proof.',
            }
          : {
              drawing: invalid,
              drawing_state: 'complete',
              drawing_description: 'Invalid colour proof.',
            }),
      })
      assert.equal(response.status, 400, `${path}: ${await response.clone().text()}`)
      assert.match((await response.json() as { error: string }).error, /drawing.*#rrggbb/iu)
      assert.equal(networkCalled('base-rpc.test') || networkCalled('facilitator.test'), false)
      assert.equal(sqlCalls().some(call => /update\s+(?:places|things)|insert\s+into\s+kind/iu.test(call.query ?? '')), false)
    }
  })

  test('drawing state, description, refusal, and variants fail closed as one write contract', async () => {
    const invalidPlaceBodies = [
      { drawing: CONTRACT_DRAWING },
      { drawing: CONTRACT_DRAWING, drawing_state: 'complete' },
      { drawing: CONTRACT_DRAWING, drawing_description: CONTRACT_DRAWING_DESCRIPTION },
      {
        drawing: CONTRACT_DRAWING,
        drawing_state: 'finished',
        drawing_description: CONTRACT_DRAWING_DESCRIPTION,
      },
      { drawing: 'REFUSE' },
      { drawing: 'refuse', drawing_description: 'Lowercase text is not the refusal sentinel.' },
      { drawing: null, drawing_state: 'complete' },
      { drawing: null, drawing_description: 'A cleared drawing has no authored description.' },
      { drawing_state: 'complete', drawing_description: CONTRACT_DRAWING_DESCRIPTION },
    ]
    for (const body of invalidPlaceBodies) {
      reset({ scenario: 'invalid paired place drawing', placeOwnerId: 7 })
      const response = await app.request('/api/place/2', {
        method: 'PATCH', headers: authHeaders(), body: JSON.stringify(body),
      })
      assert.equal(response.status, 400, JSON.stringify(body))
      assert.equal(
        sqlCalls().some(call => /update\s+places\s+set|insert\s+into\s+drawing_revisions/iu.test(call.query ?? '')),
        false,
        JSON.stringify(body),
      )
    }

    const invalidVariants = [
      Array.from({ length: 9 }, (_, index) => ({
        name: `variant-${index}`,
        drawing: CONTRACT_DRAWING,
        drawing_state: 'complete',
        drawing_description: `Variant ${index}`,
      })),
      ['same', 'same'].map(name => ({
        name,
        drawing: CONTRACT_DRAWING,
        drawing_state: 'complete',
        drawing_description: 'Duplicate exact variant name.',
      })),
      [{
        name: 'missing-description',
        drawing: CONTRACT_DRAWING,
        drawing_state: 'complete',
      }],
    ]
    for (const drawingVariants of invalidVariants) {
      reset({ scenario: 'invalid kind variants' })
      const response = await app.request('/api/kind', {
        method: 'POST', headers: authHeaders(), body: JSON.stringify({
          name: 'invalid-variants', traits: [], recipe: [], drawing_variants: drawingVariants,
        }),
      })
      assert.equal(response.status, 400, JSON.stringify(drawingVariants))
      assert.equal(networkCalled('base-rpc.test') || networkCalled('facilitator.test'), false)
      assert.equal(inserted('kinds'), 0)
    }
  })

  test('a maximum valid thing body still fits its actual-byte drawing-aware request envelope', async () => {
    reset({ scenario: 'maximum escaped thing body', thingOwnerId: 7 })
    const body = '\\'.repeat(65_536)
    const requestBody = JSON.stringify({ body, drawing: null })
    assert.ok(Buffer.byteLength(requestBody, 'utf8') > 131_072)

    const response = await app.request('/api/thing/41', {
      method: 'PATCH',
      headers: authHeaders(),
      body: requestBody,
    })

    assert.equal(response.status, 200, await response.clone().text())
  })
}
