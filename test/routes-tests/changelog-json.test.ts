import assert from 'node:assert/strict'
import { getRoutesTestContext } from '../helpers/routes-fixtures/context.ts'

interface ChangelogJsonEntry {
  readonly id: number
  readonly date: string
  readonly category: string
  readonly text: string
}

interface ChangelogJsonPage {
  readonly deployment_commit: string | null
  readonly text_sha256: string
  readonly newest_id: number
  readonly entries: readonly ChangelogJsonEntry[]
  readonly has_more: boolean
  readonly next_before_id: number | null
}

interface ChangelogJsonOne {
  readonly deployment_commit: string | null
  readonly text_sha256: string
  readonly entry: ChangelogJsonEntry
}

export function registerChangelogJsonTests(): void {
  const { app, createHash, reset, sqlCalls, test } = getRoutesTestContext()

  test('GET /api/changelog lists changelog entries as JSON, newest id first, with the serving deploy', async () => {
    reset({ scenario: 'public books' })
    const response = await app.request('/api/changelog')
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /application\/json/u)
    assert.match(response.headers.get('cache-control') ?? '', /^public, max-age=300\b/u)
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    const page = await response.json() as ChangelogJsonPage
    assert.deepEqual(Object.keys(page).sort(), [
      'deployment_commit', 'entries', 'has_more', 'newest_id', 'next_before_id', 'text_sha256',
    ])
    assert.equal(page.deployment_commit, 'e'.repeat(40))
    assert.equal(page.entries.length, 10)
    assert.equal(page.has_more, true)
    assert.equal(page.entries[0]?.id, page.newest_id)
    for (const entry of page.entries) {
      assert.deepEqual(Object.keys(entry).sort(), ['category', 'date', 'id', 'text'])
      assert.ok(Number.isSafeInteger(entry.id) && entry.id > 0)
      assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/u)
      assert.ok(entry.text.length > 0)
    }
    const ids = page.entries.map(entry => entry.id)
    assert.deepEqual(ids, [...ids].sort((left, right) => right - left), 'newest id first')
    assert.equal(page.next_before_id, ids.at(-1))

    const nextResponse = await app.request(`/api/changelog?before_id=${page.next_before_id}`)
    assert.equal(nextResponse.status, 200)
    const next = await nextResponse.json() as ChangelogJsonPage
    assert.ok(next.entries.length > 0)
    assert.ok(next.entries.every(entry => entry.id < (page.next_before_id ?? 0)))
    assert.equal(next.newest_id, page.newest_id, 'newest_id names the whole changelog, not the page')

    const official = await (await app.request('/api/official')).json() as { deployment_commit: string | null }
    assert.equal(page.deployment_commit, official.deployment_commit)
    const text = await (await app.request('/changelog.txt')).text()
    assert.equal(page.text_sha256, createHash('sha256').update(text, 'utf8').digest('hex'))
    assert.equal(sqlCalls().length, 0, 'the changelog is read from the deployed code, never PostgreSQL')
  })

  test('GET /api/changelog?after_id returns only the entries added since a saved newest_id', async () => {
    reset({ scenario: 'public books' })
    const first = await (await app.request('/api/changelog')).json() as ChangelogJsonPage
    const response = await app.request(`/api/changelog?after_id=${first.newest_id - 2}`)
    assert.equal(response.status, 200)
    const page = await response.json() as ChangelogJsonPage
    assert.deepEqual(page.entries.map(entry => entry.id), [first.newest_id, first.newest_id - 1])
    assert.equal(page.has_more, false)
    assert.equal(page.next_before_id, null)

    const all = await (await app.request('/api/changelog?limit=200')).json() as ChangelogJsonPage
    assert.equal(all.entries.length, 200, 'limit=200 is the published page maximum')
    if (all.has_more) {
      const rest = await (await app.request(`/api/changelog?limit=200&before_id=${all.next_before_id}`)).json() as ChangelogJsonPage
      assert.ok(rest.entries.length > 0)
      assert.ok(rest.entries.every(entry => !all.entries.some(seen => seen.id === entry.id)))
    } else {
      assert.equal(all.next_before_id, null)
    }
    const empty = await (await app.request(`/api/changelog?after_id=${first.newest_id}`)).json() as ChangelogJsonPage
    assert.deepEqual(empty.entries, [])
    assert.equal(empty.has_more, false)
  })

  test('GET /api/changelog refuses bad paging and unknown options with the shared public-read text', async () => {
    reset({ scenario: 'public books' })
    for (const [path, expected] of [
      ['/api/changelog?limit=0', 'limit must be between 1 and 200'],
      ['/api/changelog?limit=201', 'limit must be between 1 and 200'],
      ['/api/changelog?before_id=abc', 'before_id must be a positive integer'],
      ['/api/changelog?after_id=0', 'after_id must be a positive integer'],
      ['/api/changelog?before_id=5&after_id=5', 'after_id and before_id name one range of records, so after_id must be lower than before_id; retry with a lower after_id'],
      ['/api/changelog?foo=1', 'unsupported query option: foo; remove the shown option and retry'],
    ] as const) {
      const response = await app.request(path)
      assert.equal(response.status, 400, path)
      const body = await response.json() as { error: string }
      assert.equal(body.error, expected, path)
    }
  })

  test('GET /api/changelog/:id returns one entry word for word, and refuses bad or unknown ids', async () => {
    reset({ scenario: 'public books' })
    const first = await (await app.request('/api/changelog')).json() as ChangelogJsonPage
    const response = await app.request(`/api/changelog/${first.newest_id}`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('cache-control') ?? '', /^public, max-age=300\b/u)
    const one = await response.json() as ChangelogJsonOne
    assert.deepEqual(Object.keys(one).sort(), ['deployment_commit', 'entry', 'text_sha256'])
    assert.deepEqual(one.entry, first.entries[0])
    assert.equal(one.deployment_commit, 'e'.repeat(40))
    assert.equal(one.text_sha256, first.text_sha256)
    const text = await (await app.request('/changelog.txt')).text()
    assert.ok(text.includes(`- ${one.entry.text}\n`), 'the JSON text is the bullet exactly as written')

    for (const path of ['/api/changelog/abc', '/api/changelog/0', '/api/changelog/-1', '/api/changelog/1.5']) {
      const bad = await app.request(path)
      assert.equal(bad.status, 400, path)
      assert.equal((await bad.json() as { error: string }).error, 'changelog entry id must be a positive integer', path)
    }
    const missing = await app.request('/api/changelog/999999')
    assert.equal(missing.status, 404)
    assert.equal(
      (await missing.json() as { error: string }).error,
      'changelog entry 999999 was not found; list current entry ids with GET /api/changelog if your client can open URLs',
    )
    const unknownOption = await app.request('/api/changelog/1?x=1')
    assert.equal(unknownOption.status, 400)
    assert.equal(
      (await unknownOption.json() as { error: string }).error,
      'unsupported query option: x; remove the shown option and retry',
    )
  })
}
