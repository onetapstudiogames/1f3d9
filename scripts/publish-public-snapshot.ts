import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { verifySnapshotDirectory } from '../src/public-snapshot-format.ts'

export type GitHubRequest = Readonly<{
  method: 'GET' | 'POST' | 'PATCH'
  path: string
  body?: string | Uint8Array
  contentType?: string
  uploadName?: string
}>

export type GitHubResponse = Readonly<{
  status: number
  body: unknown
}>

type GitHubRequester = (request: GitHubRequest) => Promise<GitHubResponse>

function object(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

async function defaultGitHubRequest(
  token: string,
  request: GitHubRequest,
): Promise<GitHubResponse> {
  const base = request.path.startsWith('https://')
    ? request.path
    : `https://api.github.com${request.path}`
  const url = new URL(base.replace('{?name,label}', ''))
  if (request.uploadName) url.searchParams.set('name', request.uploadName)
  const response = await fetch(url, {
    method: request.method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      ...(request.body === undefined
        ? {}
        : { 'content-type': request.contentType ?? 'application/json' }),
    },
    ...(request.body === undefined ? {} : { body: request.body as BodyInit }),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  let body: unknown = {}
  if (text) {
    try {
      body = JSON.parse(text) as unknown
    } catch {
      body = { message: 'GitHub returned a non-JSON response' }
    }
  }
  return Object.freeze({ status: response.status, body })
}

function requiredToken(token: string): string {
  const value = token.trim()
  if (!value) throw new Error('GITHUB_TOKEN is required for checked duplicate detection')
  return value
}

function validRepository(repository: string): string {
  const value = repository.trim()
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value)) {
    throw new Error('GitHub repository must be owner/name')
  }
  return value
}

async function ensureAbsent(
  request: GitHubRequester,
  path: string,
  label: string,
): Promise<void> {
  const response = await request({ method: 'GET', path })
  if (response.status === 404) return
  if (response.status >= 200 && response.status < 300) throw new Error(`${label} already exists; refusing replacement`)
  throw new Error(`GitHub could not prove ${label} is absent (HTTP ${response.status})`)
}

async function ensureNoReleaseWithTag(
  request: GitHubRequester,
  repository: string,
  tag: string,
): Promise<void> {
  const pageSize = 100
  const maximumPages = 100
  for (let page = 1; page <= maximumPages; page += 1) {
    const response = await request({
      method: 'GET',
      path: `/repos/${repository}/releases?per_page=${pageSize}&page=${page}`,
    })
    if (response.status !== 200 || !Array.isArray(response.body)) {
      throw new Error(`GitHub could not prove release ${tag} is absent (HTTP ${response.status})`)
    }
    const releases = response.body.map(object)
    if (releases.some(release => release?.tag_name === tag)) {
      throw new Error(`release ${tag} already exists; refusing replacement`)
    }
    if (releases.length < pageSize) return
  }
  throw new Error(`GitHub could not prove release ${tag} is absent (release list is too large)`)
}

export async function publishSnapshot(input: Readonly<{
  directory: string
  repository: string
  token: string
  dryRun: boolean
  request?: GitHubRequester
}>): Promise<Readonly<{
  published: boolean
  tag: string
  city_root_sha256: string
  assets: number
}>> {
  const repository = validRepository(input.repository)
  const token = requiredToken(input.token)
  const bundle = await verifySnapshotDirectory(input.directory)
  const manifest = JSON.parse(await readFile(join(input.directory, 'manifest.json'), 'utf8')) as {
    source_commit?: unknown
  }
  if (typeof manifest.source_commit !== 'string' || !/^[0-9a-f]{40}$/u.test(manifest.source_commit)) {
    throw new Error('verified manifest has no source commit')
  }
  const requester = input.request ?? (request => defaultGitHubRequest(token, request))
  const encodedTag = encodeURIComponent(bundle.tag)
  await ensureAbsent(
    requester,
    `/repos/${repository}/git/ref/tags/${encodedTag}`,
    `tag ${bundle.tag}`,
  )
  await ensureAbsent(
    requester,
    `/repos/${repository}/releases/tags/${encodedTag}`,
    `release ${bundle.tag}`,
  )
  await ensureNoReleaseWithTag(requester, repository, bundle.tag)
  if (input.dryRun) {
    return Object.freeze({
      published: false,
      tag: bundle.tag,
      city_root_sha256: bundle.city_root_sha256,
      assets: bundle.files.length,
    })
  }

  const releaseResponse = await requester({
    method: 'POST',
    path: `/repos/${repository}/releases`,
    body: JSON.stringify({
      tag_name: bundle.tag,
      target_commitish: manifest.source_commit,
      name: `1F3D9 public snapshot ${bundle.exported_at.slice(0, 10)}`,
      body:
        `Format v1 public city snapshot.\n\n` +
        `City root SHA-256: \`${bundle.city_root_sha256}\`\n` +
        `Source commit: \`${manifest.source_commit}\`\n\n` +
        'Original assets are append-only. Any correction must be a separate erratum; never replace these files.',
      draft: true,
      prerelease: false,
    }),
  })
  const release = object(releaseResponse.body)
  const releaseId = release?.id
  const uploadUrl = release?.upload_url
  if (
    release === null || releaseResponse.status !== 201 ||
    !Number.isSafeInteger(releaseId) ||
    release.tag_name !== bundle.tag ||
    release.draft !== true ||
    typeof uploadUrl !== 'string' || !uploadUrl.startsWith('https://uploads.github.com') &&
      !uploadUrl.startsWith('https://uploads.github.test')
  ) throw new Error(`GitHub did not create the checked draft release (HTTP ${releaseResponse.status})`)
  if (!Array.isArray(release.assets) || release.assets.length !== 0) {
    throw new Error('new draft release unexpectedly contains an asset; refusing upload')
  }

  for (const file of bundle.files) {
    const bytes = await readFile(join(input.directory, file.path))
    const uploaded = await requester({
      method: 'POST',
      path: uploadUrl,
      body: bytes,
      contentType: file.path.endsWith('.json') ? 'application/json' : 'application/x-ndjson',
      uploadName: file.path,
    })
    const uploadedAsset = object(uploaded.body)
    if (
      uploaded.status !== 201 ||
      uploadedAsset?.name !== file.path ||
      uploadedAsset.size !== bytes.byteLength
    ) {
      throw new Error(`GitHub did not upload ${file.path}; draft release left unpublished`)
    }
  }

  const remoteAssetsResponse = await requester({
    method: 'GET',
    path: `/repos/${repository}/releases/${releaseId}/assets?per_page=100`,
  })
  const remoteAssets = Array.isArray(remoteAssetsResponse.body)
    ? remoteAssetsResponse.body.map(object)
    : []
  const expectedAssets = bundle.files
    .map(file => `${file.path}:${file.bytes}`)
    .sort()
  const actualAssets = remoteAssets.flatMap(asset => (
    asset && typeof asset.name === 'string' && Number.isSafeInteger(asset.size)
      ? [`${asset.name}:${asset.size}`]
      : []
  )).sort()
  if (
    remoteAssetsResponse.status !== 200 ||
    remoteAssets.length !== bundle.files.length ||
    JSON.stringify(actualAssets) !== JSON.stringify(expectedAssets)
  ) {
    throw new Error('GitHub draft assets do not exactly match the verified snapshot; draft left unpublished')
  }

  const published = await requester({
    method: 'PATCH',
    path: `/repos/${repository}/releases/${releaseId}`,
    body: JSON.stringify({ draft: false }),
  })
  const publishedRelease = object(published.body)
  if (
    published.status < 200 || published.status >= 300 ||
    publishedRelease?.tag_name !== bundle.tag ||
    publishedRelease.draft !== false
  ) {
    throw new Error('GitHub did not publish the complete draft release')
  }
  return Object.freeze({
    published: true,
    tag: bundle.tag,
    city_root_sha256: bundle.city_root_sha256,
    assets: bundle.files.length,
  })
}

function valueAfter(arguments_: readonly string[], name: string): string | null {
  const positions = arguments_
    .map((argument, index) => argument === `--${name}` ? index : -1)
    .filter(index => index >= 0)
  if (positions.length !== 1) return null
  const value = arguments_[positions[0]! + 1]
  return value && !value.startsWith('--') ? value : null
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2)
  const directory = valueAfter(arguments_, 'dir')
  const dryRun = arguments_.includes('--dry-run')
  const publish = arguments_.includes('--publish')
  if (!directory || dryRun === publish || arguments_.length !== 3) {
    throw new Error('Usage: npm run snapshot:publish -- --dir <snapshot-directory> (--dry-run|--publish)')
  }
  const result = await publishSnapshot({
    directory,
    repository: process.env.GITHUB_REPOSITORY ?? 'onetapstudiogames/1f3d9',
    token: process.env.GITHUB_TOKEN ?? '',
    dryRun,
  })
  console.log(JSON.stringify(result))
}

const entrypoint = process.argv[1]
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'public snapshot publication failed')
    process.exitCode = 1
  })
}
