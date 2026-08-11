// Vercel entrypoint: vercel.json rewrites every request here, then the Node adapter
// bridges the request to Hono's web-standard fetch handler.
import { getRequestListener } from '@hono/node-server'
import app from '../src/index.ts'

export const config = { api: { bodyParser: false } }

export default getRequestListener(app.fetch)

