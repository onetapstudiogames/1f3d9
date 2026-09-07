import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { createServer } from 'node:net'
import { createServer as createHttpServer, type Server } from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'

export type NetworkFailure = 'refused' | 'dns' | 'interrupted' | 'timeout' | 'redirect' | 'prose'

async function listen(server: Server, host: string): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return `http://${host}:${address.port}`
}

export async function redirectStub(sameOrigin: boolean, status: number, location?: string | null) {
  const visits: string[] = []
  const destinationServer = createHttpServer((request, response) => {
    visits.push('other host')
    request.resume()
    response.end('{}')
  })
  let destination = await listen(destinationServer, '127.0.0.2') + '/destination'
  const sourceServer = createHttpServer((request, response) => {
    visits.push(request.url ?? '')
    request.resume()
    if (request.url === '/destination') response.end('{}')
    else response.writeHead(status, location === null ? {} : { location: location ?? destination }).end()
  })
  const origin = await listen(sourceServer, '127.0.0.1')
  if (sameOrigin) destination = `${origin}/destination`
  return {
    origin, destination, visits,
    async close() {
      for (const server of [sourceServer, destinationServer]) {
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      }
    },
  }
}

export async function refusedConnectionOrigin(): Promise<string> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return `http://127.0.0.1:${address.port}`
}

// Loaded only into a disposable CLI child. Every credential command is fake;
// real fetches are limited to the closed loopback port or redirect stubs.
if (process.env.IDENTITY_NETWORK_CASE) {
  assert.equal(process.env.AGENT_1F3D9_STUB_ONLY, '1')
  assert.equal(process.env.AGENT_1F3EA_STUB_ONLY, '1')
  const scenario = JSON.parse(process.env.IDENTITY_NETWORK_CASE) as {
    origin: string
    path: string
    actions: string[]
    failAt: number
    failure: NetworkFailure
    responses: Record<string, unknown>[]
    tty?: boolean
  }
  if (scenario.tty) Object.defineProperty(process.stdout, 'isTTY', { value: true })
  const entries = new Map<string, string>()
  os.platform = () => 'win32'
  childProcess.execFileSync = ((command: string, args: string[], options: { input?: string }) => {
    if (command === 'cmdkey' && args[0]?.startsWith('/delete:')) {
      entries.delete(args[0].slice('/delete:'.length))
      return ''
    }
    assert.equal(command, 'powershell.exe', 'all credential commands must use the fake')
    if (options.input !== undefined) {
      const { target, blob } = JSON.parse(options.input) as { target: string; blob: string }
      entries.set(target, blob)
      return ''
    }
    const target = args.at(-1)?.match(/CredRead\('([^']+)'/u)?.[1]
    if (!target || !entries.has(target)) throw new Error('fake credential not found')
    return entries.get(target)!
  }) as typeof childProcess.execFileSync
  syncBuiltinESMExports()

  const realFetch = globalThis.fetch
  let call = 0
  globalThis.fetch = async (url, init) => {
    call += 1
    assert.equal(String(url), `${scenario.origin}${scenario.path}`)
    const body = JSON.parse(String(init?.body)) as { action?: string }
    assert.equal(body.action ?? 'pair', scenario.actions[call - 1])
    if (call === scenario.failAt) {
      if (scenario.failure === 'prose') {
        return Response.json(scenario.responses[call - 1], { status: 401 })
      }
      if (scenario.failure === 'refused' || scenario.failure === 'redirect') {
        assert.match(scenario.origin, /^http:\/\/127\.0\.0\.1:\d+$/u)
        return realFetch(url, init)
      }
      const code = scenario.failure === 'dns' ? 'ENOTFOUND'
        : scenario.failure === 'timeout' ? 'UND_ERR_CONNECT_TIMEOUT' : 'ECONNRESET'
      const cause = Object.assign(new Error(`engine detail ${code}: do-not-print-this-marker`), { code })
      throw new TypeError('fetch failed', {
        cause: scenario.failAt === 2 ? new AggregateError([cause], '') : cause,
      })
    }
    const response = scenario.responses[call - 1]
    assert.ok(response, `unexpected request ${call} must never reach a real server`)
    return Response.json(response)
  }
}
