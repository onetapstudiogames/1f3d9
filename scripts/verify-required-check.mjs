import { readFileSync } from 'node:fs'

const REQUIRED_CHECK_NAME = 'checks'
const REQUIRED_CHECK_APP_ID = 15368

/** @param {unknown} value */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param {Record<string, unknown>} run */
function appId(run) {
  return isRecord(run.app) && typeof run.app.id === 'number'
    ? run.app.id
    : undefined
}

/**
 * @param {unknown} response
 * @param {string} expectedCommit
 * @returns {{ok: true, checkRunId: number} | {ok: false, reason: string}}
 */
export function verifyRequiredCheck(response, expectedCommit) {
  if (!isRecord(response) || !Array.isArray(response.check_runs)) {
    return { ok: false, reason: 'GitHub returned no usable check-runs list' }
  }

  const candidates = response.check_runs
    .filter(isRecord)
    .filter(run => (
      run.name === REQUIRED_CHECK_NAME &&
      appId(run) === REQUIRED_CHECK_APP_ID &&
      run.head_sha === expectedCommit
    ))

  if (candidates.length === 0) {
    return { ok: false, reason: 'no required checks run matches this exact candidate' }
  }

  if (candidates.some(run => typeof run.id !== 'number')) {
    return { ok: false, reason: 'a matching required checks run has no usable id' }
  }

  const latest = candidates.reduce((newest, run) => (
    Number(run.id) > Number(newest.id) ? run : newest
  ))
  if (latest.status !== 'completed' || latest.conclusion !== 'success') {
    return {
      ok: false,
      reason: `latest required checks run is ${String(latest.status)}/${String(latest.conclusion)}`,
    }
  }

  return { ok: true, checkRunId: Number(latest.id) }
}

try {
  const expectedCommit = process.argv[2]
  if (!expectedCommit) throw new Error('expected candidate commit is required')
  const response = JSON.parse(readFileSync(0, 'utf8'))
  const result = verifyRequiredCheck(response, expectedCommit)
  if (!result.ok) throw new Error(result.reason)
  console.log(`required checks run ${result.checkRunId} passed for the exact candidate`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
