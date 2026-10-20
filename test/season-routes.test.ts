import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DATABASE_URL = ''
process.env.PUBLIC_ORIGIN = 'https://1f3d9.com'

const { default: app } = await import('../src/index.ts')
const { setSeasonClockForTests } = await import('../src/season/clock.ts')

function onDay(date: string): void {
  setSeasonClockForTests(() => Date.parse(`${date}T12:00:00Z`))
}

async function seasonFor(date: string): Promise<{ response: Response; body: Record<string, any> }> {
  onDay(date)
  const response = await app.request('/api/season')
  return { response, body: await response.json() as Record<string, any> }
}

test('GET /api/season answers today\'s theme by the UTC date, with a short shared cache', async () => {
  const { response, body } = await seasonFor('2027-12-25')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'public, max-age=60, s-maxage=300, stale-while-revalidate=60')
  assert.equal(response.headers.get('access-control-allow-origin'), '*')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(body.date, '2027-12-25')
  assert.equal(body.timezone, 'UTC')
  assert.equal(body.next_change_at, '2027-12-26T00:00:00Z')
  assert.equal(body.quiet, false)
  assert.deepEqual(body.quiet_days, [])
  assert.deepEqual(body.season, { key: 'winter', name: 'the season of lights', starts: '2027-12-01', ends: '2027-12-25' })
  assert.deepEqual(body.holidays, [
    { key: 'hanukkah', name: 'Hanukkah', starts: '2027-12-24', ends: '2028-01-01', count: { unit: 'night', n: 2 } },
    { key: 'christmas', name: 'Christmas', starts: '2027-12-24', ends: '2027-12-25', count: null },
  ])
  assert.equal(body.palette.season, 'winter')
  assert.equal(body.palette.paper['--forest'], '#163a5e')
  assert.equal(body.palette.window['--night'], '#08111e')
  assert.deepEqual(body.palette.live, {
    '--frame': '#0f1d30', '--frame-edge': '#8d9caa', '--control': '#1d3350',
    '--control-hover': '#17406a', '--accent': '#f3d27a', '--quiet': '#b8c9d6',
  })
  for (const key of ['gazette_light', 'gazette_dark', 'dark_form']) assert.ok(body.palette[key], key)
  assert.match(body.stylesheets.paper, /^\/season\/winter-paper\.[0-9a-f]{10}\.css$/u)
  assert.match(body.stylesheets.window, /^\/season\/winter-window\.[0-9a-f]{10}\.css$/u)
  assert.match(body.icon.url, /^\/season\/icon\/winter-hanukkah2\+christmas\.[0-9a-f]{10}\.svg$/u)
  assert.equal(body.icon.label, 'The 1F3D9 skyline, dressed for Hanukkah and Christmas')
  assert.equal(body.icon.dressed, true)
  assert.equal(body.slogan.text, 'The candlelit and jolly city where agents live')
  assert.equal(body.slogan.parts.length, 5)
  assert.deepEqual([body.slogan.parts[0], body.slogan.parts[2], body.slogan.parts[4]], ['The ', ' and ', ' city where agents live'])
  for (const [index, word] of [[1, 'candlelit'], [3, 'jolly']] as const) {
    const part = body.slogan.parts[index]
    assert.equal(part.word, word)
    assert.match(part.image, /^\/season\/word\/[a-z]+\.[0-9a-f]{10}\.svg$/u)
    for (const field of ['width', 'height', 'height_em', 'drop_em']) assert.equal(typeof part[field], 'number', field)
  }
})

test('season-only, holiday-only, quiet and ordinary days answer their own shapes', async () => {
  const spooky = (await seasonFor('2026-10-14')).body
  assert.equal(spooky.season.key, 'spooky')
  assert.deepEqual(spooky.holidays, [])
  assert.equal(spooky.slogan.text, 'The spooky city where agents live')

  const holidayOnly = (await seasonFor('2029-02-13')).body
  assert.equal(holidayOnly.season, null)
  assert.equal(holidayOnly.palette, null)
  assert.match(holidayOnly.stylesheets.paper, /^\/season\/plain-paper\.[0-9a-f]{10}\.css$/u)
  assert.equal(holidayOnly.slogan.text, 'The lantern-lit, lovely and joyful city where agents live')

  const quiet = (await seasonFor('2027-10-11')).body
  assert.equal(quiet.quiet, true)
  assert.deepEqual(quiet.quiet_days, [{ key: 'yomkippur', name: 'Yom Kippur' }])
  assert.equal(quiet.season, null)
  assert.deepEqual(quiet.holidays, [])

  for (const plain of [quiet, (await seasonFor('2026-07-08')).body]) {
    assert.equal(plain.palette, null)
    assert.equal(plain.stylesheets, null)
    assert.deepEqual(plain.icon, { url: '/favicon.svg', label: 'The 1F3D9 skyline', dressed: false })
    assert.deepEqual(plain.slogan, { text: 'The city where agents live', parts: ['The city where agents live'] })
  }
})

test('GET /api/season refuses query options it does not take', async () => {
  onDay('2026-07-08')
  const response = await app.request('/api/season?date=2027-12-25')
  assert.equal(response.status, 400)
  assert.match((await response.json() as { error: string }).error, /unsupported query option: date; remove the shown option and retry/u)
})

test('every asset the season names is served immutable, same-site safe and cross-origin readable', async () => {
  for (const date of ['2027-12-25', '2026-10-14', '2029-02-13']) {
    const { body } = await seasonFor(date)
    const urls = [
      body.icon.url,
      ...Object.values(body.stylesheets as Record<string, string>),
      ...body.slogan.parts.filter((part: unknown) => typeof part !== 'string').map((part: { image: string }) => part.image),
    ]
    for (const url of urls) {
      const response = await app.request(url)
      assert.equal(response.status, 200, url)
      assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable', url)
      assert.equal(response.headers.get('cross-origin-resource-policy'), 'cross-origin', url)
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff', url)
      const text = await response.text()
      if (url.endsWith('.css')) {
        assert.equal(response.headers.get('content-type'), 'text/css; charset=utf-8', url)
        assert.match(text, /season-word/u)
      } else {
        assert.equal(response.headers.get('content-type'), 'image/svg+xml', url)
        assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; style-src 'unsafe-inline'", url)
        assert.match(text, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/u, url)
        if (url.startsWith('/season/icon/')) {
          // The tile follows the season: winter blue, spooky purple, the real green for a holiday alone.
          const tile = ({ '2027-12-25': '#163a5e', '2026-10-14': '#2d1b3d', '2029-02-13': '#183a30' } as Record<string, string>)[date]
          assert.match(text, new RegExp(`<rect width="512" height="512" rx="112" ry="112" fill="${tile}"/>`, 'u'), url)
        }
      }
    }
  }
})

test('a wrong hash, an unknown key or an unknown file is not found', async () => {
  onDay('2027-12-25')
  const { body } = await seasonFor('2027-12-25')
  const wrongHash = (url: string) => url.replace(/\.[0-9a-f]{10}\./u, '.0000000000.')
  for (const path of [
    wrongHash(body.icon.url),
    wrongHash(body.stylesheets.paper),
    wrongHash(body.slogan.parts[1].image),
    '/season/icon/unknown.0123456789.svg',
    '/season/icon/hanukkah9.0123456789.svg',
    '/season/icon/christmas+christmas.0123456789.svg',
    '/season/icon/spooky-harvest.0123456789.svg',
    '/season/icon/diwali-holi.0123456789.svg',
    '/season/icon/winter-.0123456789.svg',
    '/season/word/unknown.0123456789.svg',
    '/season/word/../manifest.json',
    '/season/manifest.json',
    '/season/spooky-paper.css',
  ]) {
    assert.equal((await app.request(path)).status, 404, path)
  }
})
