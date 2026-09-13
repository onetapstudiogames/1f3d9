import { readFile, writeFile } from 'node:fs/promises'

// Pin the plugin artifact so this site can build before either B9 PR merges.
const PLUGIN_COMMIT = '138e4877117366f144a187be09953ea1fd83b385'
const PLUGIN_RAW = 'https://raw.githubusercontent.com/onetapstudiogames/1f3d9-citylife'
const OUTPUT = new URL('../src/listing-metadata.generated.ts', import.meta.url)

async function fetchJson(ref, allow404 = false) {
  const response = await fetch(`${PLUGIN_RAW}/${ref}/docs/listing-metadata.json`, {
    signal: AbortSignal.timeout(10_000),
  })
  if (allow404 && response.status === 404) return null
  if (!response.ok) throw new Error(`plugin listing metadata fetch failed: ${response.status} (${ref})`)
  return await response.json()
}

const localSourceIndex = process.argv.indexOf('--local-source')
const localSource = localSourceIndex >= 0 ? process.argv[localSourceIndex + 1] : null
const metadata = localSource
  ? JSON.parse(await readFile(localSource, 'utf8'))
  : await fetchJson(PLUGIN_COMMIT)

if (!metadata || typeof metadata.displayName !== 'string'
  || typeof metadata.longDescription !== 'string'
  || !Array.isArray(metadata.directories)) {
  throw new Error('plugin listing metadata has an invalid shape')
}

if (!localSource) {
  const upstream = await fetchJson('main', true)
  if (upstream && JSON.stringify(upstream) !== JSON.stringify(metadata)) {
    throw new Error('plugin main listing metadata changed; update PLUGIN_COMMIT and run node scripts/sync-city-listings.mjs')
  }
  if (!upstream) {
    const manifestResponse = await fetch(`${PLUGIN_RAW}/main/plugin.json`, {
      signal: AbortSignal.timeout(10_000),
    })
    if (!manifestResponse.ok) throw new Error(`plugin main manifest fetch failed: ${manifestResponse.status}`)
    const manifest = await manifestResponse.json()
    const parts = version => /^\d+\.\d+\.\d+$/u.test(String(version))
      ? String(version).split('.').map(Number) : []
    const mainVersion = parts(manifest.version)
    const pinnedVersion = parts(metadata.version)
    if (mainVersion.length !== 3 || pinnedVersion.length !== 3
      || mainVersion.some(Number.isNaN) || pinnedVersion.some(Number.isNaN)
      || mainVersion[0] > pinnedVersion[0]
      || (mainVersion[0] === pinnedVersion[0] && mainVersion[1] > pinnedVersion[1])
      || (mainVersion[0] === pinnedVersion[0] && mainVersion[1] === pinnedVersion[1]
        && mainVersion[2] >= pinnedVersion[2])) {
      throw new Error('plugin main listing metadata is missing at or after the pinned version')
    }
  }
}

const output = `// Generated from 1f3d9-citylife docs/listing-metadata.json at ${PLUGIN_COMMIT}.\n// Refresh: node scripts/sync-city-listings.mjs\nexport const CITY_LISTING_METADATA = ${JSON.stringify(metadata, null, 2)} as const\n`
if (process.argv.includes('--check')) {
  const current = await readFile(OUTPUT, 'utf8').catch(() => '')
  if (current !== output) throw new Error('city listing metadata is stale; run node scripts/sync-city-listings.mjs')
} else {
  await writeFile(OUTPUT, output)
}
