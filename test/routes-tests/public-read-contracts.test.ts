import assert from 'node:assert/strict'
import { getRoutesTestContext } from '../helpers/routes-fixtures/context.ts'


export function registerPublicReadContractsTests(): void {
  const {
    allowedPublicQuery,
    app,
    fixtureState,
    paginationEvents,
    recentIds,
    remainingPaginationRows,
    reset,
    sqlCalls,
    test,
    utf8TextBytes,
  } = getRoutesTestContext()


  test('public read options reject unknown names and text sizes count UTF-8 bytes', () => {
    assert.deepEqual(allowedPublicQuery({ limit: ['2'], q: ['pretend-search'] }, ['limit']), {
      ok: false,
      error: 'unsupported query option: q; remove the shown option and retry',
    })
    assert.deepEqual(allowedPublicQuery({ limit: ['2'] }, ['limit']), { ok: true })
    const oversizedName = 'x'.repeat(10_000)
    const oversized = allowedPublicQuery({ [oversizedName]: ['ignored'] }, [])
    assert.equal(oversized.ok, false)
    if (!oversized.ok) {
      assert.ok(oversized.error.length < 120, 'an attacker-controlled option name must not amplify the error')
      assert.doesNotMatch(oversized.error, new RegExp(oversizedName, 'u'))
    }
    assert.equal(utf8TextBytes([{ body: 'plain' }, { body: '🏙' }], 'body'), 9)
  })

  test('event filters reject invalid kinds instead of silently cutting them', async () => {
    for (const kind of ['', 'UPPER', `a${'b'.repeat(64)}`]) {
      reset({ scenario: 'public pagination' })
      const response = await app.request(`/api/events?kind=${encodeURIComponent(kind)}`)
      assert.equal(response.status, 400, JSON.stringify(kind))
      assert.equal(sqlCalls().length, 0, JSON.stringify(kind))
    }

    reset({ scenario: 'public pagination' })
    const valid = await app.request('/api/events?kind=note_created&limit=2')
    assert.equal(valid.status, 200)
  })

  test('exact public totals fail cheaply and honestly when database capacity is busy', async () => {
    reset({ scenario: 'public pagination', exactTotalsBusy: true })
    const response = await app.request('/api/events?limit=1')
    assert.equal(response.status, 503, 'busy exact totals must fail instead of scanning')
    assert.equal(response.headers.get('retry-after'), '1')
    assert.deepEqual(await response.json(), {
      error: 'exact public totals are temporarily busy; retry',
    })

    reset({ scenario: 'public pagination', exactTotalsBusy: true })
    const treasury = await app.request('/treasury?limit=1')
    assert.equal(treasury.status, 503)
    assert.equal(
      fixtureState.current.calls.some(call => call.url.includes('base-rpc.test')),
      false,
      'a rejected totals read must not fan out to the chain RPC',
    )
  })

  test('the exact-read guard preserves source order at its outer SQL boundary', async () => {
    const { budgetedExactStatement } = await import('../../src/public-exact-query.ts')
    const statement = budgetedExactStatement('SELECT id FROM events ORDER BY id DESC')
    assert.match(
      statement,
      /ORDER BY __public_exact_result\.id DESC NULLS LAST\s*$/iu,
    )
    assert.doesNotMatch(statement, /row_number|__public_exact_order/iu)

    const residents = budgetedExactStatement(
      'SELECT id, joined_at FROM residents ORDER BY joined_at DESC, id DESC',
      'joined_at_desc',
    )
    assert.match(
      residents,
      /ORDER BY __public_exact_result\.joined_at DESC NULLS LAST,\s*__public_exact_result\.id DESC NULLS LAST\s*$/iu,
    )
  })

  test('raw public place reads redact historical resident credentials without dropping the response', async () => {
    const credentials = [
      `1f3d9_sk_${'a1'.repeat(24)}`,
      `1f3d9_at_${'b2'.repeat(32)}`,
      `1f3d9_rt_${'c3'.repeat(32)}`,
      `1f3d9_ac_${'d4'.repeat(32)}`,
    ]

    for (const credential of credentials) {
      reset({
        scenario: 'public credential redaction',
        placeDescription: `unsafe place description ${credential}`,
        noteBody: `unsafe historical note ${credential}`,
      })

      const response = await app.request('/api/place/2?view=full')
      assert.equal(response.status, 200)
      const body = await response.json() as {
        place: { description: string; id: number }
        notes: Array<{ body: string }>
        things: Array<{ id: number }>
      }
      assert.equal(body.place.id, 2)
      assert.match(body.place.description, /redacted.*resident credential/i)
      assert.match(body.notes[0]?.body ?? '', /redacted.*resident credential/i)
      assert.equal(body.things[0]?.id, 41)
      assert.doesNotMatch(JSON.stringify(body), new RegExp(credential, 'i'))
    }
  })

  test('non-census growing public collections keep their newest-first 10-row default', async () => {
    const cases = [
      ['/api/kinds', 'kinds', 1170],
      ['/api/traits', 'traits', 1270],
      ['/api/agreements', 'agreements', 1370],
      ['/api/moderation', 'moderation', 1470],
    ] as const

    for (const [path, key, newest] of cases) {
      reset({ scenario: 'remaining pagination' })
      const response = await app.request(path)
      assert.equal(response.status, 200, path)
      const body = await response.json() as Record<string, unknown>
      const rows = body[key] as Array<{ id: number }>
      assert.equal(rows.length, 10, path)
      assert.deepEqual(rows.slice(0, 2).map(row => row.id), [newest, newest - 1], path)
      assert.equal(body.has_more, true, path)
      assert.equal(body.next_before_id, newest - 9, path)
    }
  })

  test('every growing public list reports exact total and returned authored-text bytes', async () => {
    const authoredBytes = (rows: readonly Record<string, unknown>[], field: string) => rows.reduce(
      (total, row) => total + Buffer.byteLength(typeof row[field] === 'string' ? row[field] : '', 'utf8'),
      0,
    )
    const cases = [
      {
        path: '/api/residents?limit=3', key: 'residents', scenario: 'remaining pagination',
        all: remainingPaginationRows('residents'), textField: null,
      },
      {
        path: '/api/events?limit=3', key: 'events', scenario: 'public pagination',
        all: paginationEvents(), textField: 'event_detail',
      },
      {
        path: '/api/kinds?limit=3', key: 'kinds', scenario: 'remaining pagination',
        all: remainingPaginationRows('kinds'), textField: 'description',
      },
      {
        path: '/api/traits?limit=3', key: 'traits', scenario: 'remaining pagination',
        all: remainingPaginationRows('traits'), textField: 'description',
      },
      {
        path: '/api/agreements?limit=3', key: 'agreements', scenario: 'remaining pagination',
        all: remainingPaginationRows('agreements'), textField: 'body',
      },
      {
        path: '/api/moderation?limit=3', key: 'moderation', scenario: 'remaining pagination',
        all: remainingPaginationRows('moderation'), textField: 'reason',
      },
    ] as const

    const measuredBytes = (rows: readonly Record<string, unknown>[], field: string | null) => {
      if (field === null) return 0
      if (field !== 'event_detail') return authoredBytes(rows, field)
      return rows.reduce((total, row) => {
        const detail = row.detail && typeof row.detail === 'object' && !Array.isArray(row.detail)
          ? row.detail as Record<string, unknown>
          : {}
        return total + ['body', 'description', 'reason'].reduce(
          (subtotal, name) => subtotal + Buffer.byteLength(
            typeof detail[name] === 'string' ? detail[name] as string : '',
            'utf8',
          ),
          0,
        )
      }, 0)
    }

    for (const entry of cases) {
      reset({ scenario: entry.scenario })
      const response = await app.request(entry.path)
      assert.equal(response.status, 200, entry.path)
      const body = await response.json() as Record<string, unknown>
      const rows = body[entry.key] as Record<string, unknown>[]
      assert.equal(body.total_items, entry.all.length, `${entry.path} total items`)
      assert.equal(body.total_text_bytes, measuredBytes(entry.all, entry.textField), `${entry.path} total bytes`)
      assert.equal(body.returned_items, rows.length, `${entry.path} returned items`)
      assert.equal(body.returned_text_bytes, measuredBytes(rows, entry.textField), `${entry.path} returned bytes`)
      assert.equal(body.has_more, true, `${entry.path} omission flag`)
    }
  })

  test('parameterless resident census returns every resident below its 200-row default', async () => {
    reset({ scenario: 'remaining pagination' })
    const response = await app.request('/api/residents')
    assert.equal(response.status, 200)
    const body = await response.json() as {
      residents: Array<{ id: number }>
      count: number
      total: number
      returned: number
      page_size: number
      has_more: boolean
      next_before_id: number | null
    }

    const expectedIds = recentIds(1070)
    assert.deepEqual(body.residents.map(row => row.id), expectedIds)
    assert.equal(body.count, expectedIds.length)
    assert.equal(body.total, expectedIds.length)
    assert.equal(body.returned, expectedIds.length)
    assert.equal(body.page_size, 200)
    assert.equal(body.has_more, false)
    assert.equal(body.next_before_id, null)

    const residentRead = sqlCalls().find(call => /\/\* public:residents \*\//i.test(call.query ?? ''))
    assert.deepEqual(
      residentRead?.params?.map(value => value == null ? null : Number(value)),
      [null, 201],
      'the default census query must fetch one lookahead row beyond its 200-row page',
    )
    const censusReads = sqlCalls().filter(call => (
      /\/\* public:residents \*\//i.test(call.query ?? '')
        || /\/\* public:resident-count \*\//i.test(call.query ?? '')
    ))
    assert.equal(censusReads.length, 1, 'the census page and total must share one database snapshot')
    assert.match(censusReads[0]?.query ?? '', /count\s*\(\s*\*\s*\)/i)
  })
}
