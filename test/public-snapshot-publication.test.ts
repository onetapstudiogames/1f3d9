import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createSnapshotBundle } from '../src/public-snapshot-format.ts'
import { publishSnapshot, type GitHubRequest } from '../scripts/publish-public-snapshot.ts'

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), '1f3d9-publish-'))
  const bundle = await createSnapshotBundle({
    outputDirectory: directory,
    exportedAt: '2026-08-23T12:34:56.000Z',
    sourceCommit: 'f'.repeat(40),
    records: [{
      class_name: 'residents', record_id: '1', sort_key: '1',
      payload: { id: 1, status: 'exported', handle: 'founder' },
    }],
  })
  return { directory, bundle }
}

test('publication dry run performs only duplicate checks and never creates a release', async () => {
  const { directory } = await fixture()
  const requests: GitHubRequest[] = []
  try {
    const result = await publishSnapshot({
      directory,
      repository: 'onetapstudiogames/1f3d9',
      token: 'test-token',
      dryRun: true,
      request: async request => {
        requests.push(request)
        if (request.path.includes('/releases?')) return { status: 200, body: [] }
        return { status: 404, body: {} }
      },
    })
    assert.equal(result.published, false)
    assert.equal(requests.every(request => request.method === 'GET'), true)
    assert.equal(requests.some(request => request.path.includes('/releases?')), true)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test('publication refuses an existing draft release before uploading an asset', async () => {
  const { directory, bundle } = await fixture()
  try {
    await assert.rejects(() => publishSnapshot({
      directory,
      repository: 'onetapstudiogames/1f3d9',
      token: 'test-token',
      dryRun: false,
      request: async request => {
        if (request.path.includes('/git/ref/tags/')) return { status: 404, body: {} }
        if (request.path.includes('/releases/tags/')) return { status: 404, body: {} }
        if (request.path.includes('/releases?')) {
          return { status: 200, body: [{ tag_name: bundle.tag, draft: true }] }
        }
        throw new Error('publication continued after finding an existing draft')
      },
    }), /release .*already exists/iu)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test('publication refuses an existing tag or release before uploading an asset', async () => {
  const { directory } = await fixture()
  try {
    await assert.rejects(() => publishSnapshot({
      directory,
      repository: 'onetapstudiogames/1f3d9',
      token: 'test-token',
      dryRun: false,
      request: async request => request.path.includes('/git/ref/tags/')
        ? { status: 200, body: { ref: 'existing' } }
        : { status: 404, body: {} },
    }), /tag .*already exists/iu)

    await assert.rejects(() => publishSnapshot({
      directory,
      repository: 'onetapstudiogames/1f3d9',
      token: 'test-token',
      dryRun: false,
      request: async request => request.path.includes('/git/ref/tags/')
        ? { status: 404, body: {} }
        : { status: 200, body: { tag_name: 'existing' } },
    }), /release .*already exists/iu)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test('publication creates a draft, uploads every new asset, then publishes without replacement', async () => {
  const { directory, bundle } = await fixture()
  const requests: GitHubRequest[] = []
  const uploadedAssets: Array<{ name: string; size: number }> = []
  try {
    const result = await publishSnapshot({
      directory,
      repository: 'onetapstudiogames/1f3d9',
      token: 'test-token',
      dryRun: false,
      request: async request => {
        requests.push(request)
        if (request.path.endsWith('/releases/77/assets?per_page=100')) {
          return { status: 200, body: uploadedAssets }
        }
        if (request.path.includes('/releases?')) return { status: 200, body: [] }
        if (request.method === 'GET') return { status: 404, body: {} }
        if (request.path.endsWith('/releases')) {
          return {
            status: 201,
            body: {
              id: 77,
              tag_name: bundle.tag,
              draft: true,
              upload_url: 'https://uploads.github.test/releases/77/assets{?name,label}',
              assets: [],
            },
          }
        }
        if (request.path.endsWith('/releases/77')) {
          return { status: 200, body: { tag_name: bundle.tag, draft: false } }
        }
        const size = request.body instanceof Uint8Array
          ? request.body.byteLength
          : Buffer.byteLength(request.body ?? '')
        const asset = { name: request.uploadName!, size }
        uploadedAssets.push(asset)
        return { status: 201, body: asset }
      },
    })
    assert.equal(result.published, true)
    assert.equal(result.tag, bundle.tag)
    assert.equal(requests.filter(request => request.method === 'POST' && request.uploadName).length, bundle.files.length)
    assert.equal(requests.at(-1)?.method, 'PATCH')
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})
