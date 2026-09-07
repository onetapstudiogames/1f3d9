import { Hono } from 'hono'
import { mountIdentityRoutes } from '../../../src/identity-browser.ts'
import { ORIGIN } from './browser-session.ts'
import { memoryStore, type MemoryStoreOptions } from './memory-store.ts'

export function appWithMemoryStore(options: MemoryStoreOptions = {}) {
  const app = new Hono()
  app.onError(() => new Response('Internal Server Error', { status: 500 }))
  const memory = memoryStore(options)
  mountIdentityRoutes(app, {
    environment: {
      PUBLIC_ORIGIN: ORIGIN,
      VERCEL: '1',
      IDENTITY_RECOVERY_ENABLED: 'true',
      IDENTITY_ROTATION_ENABLED: 'true',
    },
    store: memory.store,
  })
  return { app, memory }
}
