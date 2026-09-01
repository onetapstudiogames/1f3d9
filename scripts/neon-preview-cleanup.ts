import { appendFile, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

type NeonBranch = Readonly<{ id: string; name: string; primary: boolean }>
const SHARED_BRANCH = 'preview/shared-vercel-testing'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function selectPreviewBranchForClosedPullRequest(
  headReference: string,
  branches: readonly NeonBranch[],
): Readonly<{ id: string; name: string }> | null {
  if (!headReference || /[\x00-\x1f]/u.test(headReference)) return null
  const expected = `preview/${headReference}`
  if (expected === SHARED_BRANCH || expected === 'main' || !expected.startsWith('preview/')) return null
  const matches = branches.filter(branch => branch.name === expected)
  if (matches.length > 1) throw new Error('Multiple Neon branches match the closed pull request')
  const match = matches[0]
  if (!match) return null
  if (match.primary || match.name === 'main' || match.name === SHARED_BRANCH) {
    throw new Error('Refusing to delete a primary or protected Neon branch')
  }
  return Object.freeze({ id: match.id, name: match.name })
}

async function request(url: URL, token: string, fetcher: typeof fetch, init: RequestInit = {}): Promise<Response> {
  return fetcher(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...init.headers },
    signal: AbortSignal.timeout(20_000),
  })
}

async function listBranches(projectId: string, token: string, fetcher: typeof fetch): Promise<readonly NeonBranch[]> {
  const branches: NeonBranch[] = []
  let cursor: string | undefined
  const seenCursors = new Set<string>()
  for (let page = 0; page < 100; page += 1) {
    const url = new URL(`https://console.neon.tech/api/v2/projects/${encodeURIComponent(projectId)}/branches`)
    url.searchParams.set('limit', '100')
    if (cursor) url.searchParams.set('cursor', cursor)
    const response = await request(url, token, fetcher)
    if (!response.ok) throw new Error(`Neon branch list returned HTTP ${response.status}`)
    const value: unknown = await response.json()
    if (!isObject(value) || !Array.isArray(value.branches)) throw new Error('Neon returned an invalid branch list')
    for (const item of value.branches) {
      if (!isObject(item) || typeof item.id !== 'string' || typeof item.name !== 'string' ||
          typeof item.primary !== 'boolean') {
        throw new Error('Neon returned an invalid branch')
      }
      branches.push(Object.freeze({ id: item.id, name: item.name, primary: item.primary }))
    }
    cursor = isObject(value.pagination) && typeof value.pagination.next === 'string'
      ? value.pagination.next : undefined
    if (!cursor) return Object.freeze(branches)
    if (seenCursors.has(cursor)) throw new Error('Neon pagination cursor repeated')
    seenCursors.add(cursor)
    if (branches.length > 10_000) throw new Error('Neon branch list exceeded safety limit')
  }
  throw new Error('Neon branch pagination exceeded page limit')
}

export async function runNeonPreviewCleanup(input: Readonly<{
  environment?: NodeJS.ProcessEnv
  event?: unknown
  fetcher?: typeof fetch
  log?: (line: string) => void
}> = {}): Promise<void> {
  const environment = input.environment ?? process.env
  const fetcher = input.fetcher ?? fetch
  const log = input.log ?? console.log
  const writeSummary = async (line: string): Promise<void> => {
    if (environment.GITHUB_STEP_SUMMARY) await appendFile(environment.GITHUB_STEP_SUMMARY, `${line}\n`)
    log(line)
  }
  const token = environment.NEON_API_KEY
  const projectId = environment.NEON_PROJECT_ID
  const eventPath = environment.GITHUB_EVENT_PATH
  if (!token || !projectId) {
    await writeSummary('Neon preview cleanup: SKIPPED — NEON_API_KEY or NEON_PROJECT_ID is absent.')
    return
  }
  if (!input.event && !eventPath) throw new Error('GITHUB_EVENT_PATH is absent')
  const event: unknown = input.event ?? JSON.parse(await readFile(eventPath!, 'utf8'))
  const pullRequest = isObject(event) && isObject(event.pull_request) ? event.pull_request : undefined
  const head = pullRequest && isObject(pullRequest.head) ? pullRequest.head : undefined
  const headReference = head?.ref
  if (typeof headReference !== 'string') throw new Error('Closed pull request head ref is absent')
  const headRepository = head && isObject(head.repo) ? head.repo.full_name : undefined
  if (typeof environment.GITHUB_REPOSITORY !== 'string' || typeof headRepository !== 'string') {
    throw new Error('Closed pull request repository identity is absent')
  }
  if (headRepository !== environment.GITHUB_REPOSITORY) {
    await writeSummary('Neon preview cleanup: SKIPPED — the closed PR came from a fork.')
    return
  }

  const target = selectPreviewBranchForClosedPullRequest(headReference, await listBranches(projectId, token, fetcher))
  if (!target) {
    await writeSummary(`Neon preview cleanup: no exact deletable branch exists for preview/${headReference}.`)
    return
  }

  const branchUrl = new URL(`https://console.neon.tech/api/v2/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(target.id)}`)
  const proofResponse = await request(branchUrl, token, fetcher)
  if (proofResponse.status === 404) {
    await writeSummary(`Neon preview cleanup: ${target.name} was already absent before deletion.`)
    return
  }
  if (!proofResponse.ok) throw new Error(`Neon branch proof returned HTTP ${proofResponse.status}`)
  const proof: unknown = await proofResponse.json()
  const branch = isObject(proof) && isObject(proof.branch) ? proof.branch : proof
  if (!isObject(branch) || branch.id !== target.id || branch.name !== target.name || branch.primary !== false) {
    throw new Error('Neon branch changed before deletion; refusing cleanup')
  }

  const deleteResponse = await request(branchUrl, token, fetcher, { method: 'DELETE' })
  if (deleteResponse.status === 404) {
    await writeSummary(`Neon preview cleanup: ${target.name} was already absent during deletion.`)
    return
  }
  if (!deleteResponse.ok) {
    throw new Error(`Neon branch deletion returned HTTP ${deleteResponse.status}`)
  }
  await writeSummary(`Neon preview cleanup: requested deletion of ${target.name}.`)
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  runNeonPreviewCleanup().catch(error => {
    const message = error instanceof Error ? error.message.replace(/[\r\n]+/gu, ' ').slice(0, 240) : 'unknown error'
    const line = `Neon preview cleanup: FAILED — ${message}`
    const write = process.env.GITHUB_STEP_SUMMARY
      ? appendFile(process.env.GITHUB_STEP_SUMMARY, `${line}\n`)
      : Promise.resolve()
    write.finally(() => { console.error(line); process.exitCode = 1 })
  })
}
