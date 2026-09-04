import { readdirSync, readFileSync, statSync } from 'node:fs'

// Phase 1 of issue #79 split the window client's runtime body out of
// src/window-client.ts into src/window-client/**.ts (helper modules and
// ordered program parts). Reads every file in that directory tree,
// regardless of extension, so a scan that used to read one file keeps
// covering the whole client, not just the now-tiny facade.
export function readDirTree(relativeDir: string, baseUrl: string | URL): string {
  const dir = relativeDir.replace(/\/?$/, '/')
  const base = new URL(dir, baseUrl)
  const names = readdirSync(base).sort()
  return names.map(name => {
    const full = new URL(dir + name, baseUrl)
    if (statSync(full).isDirectory()) return readDirTree(dir + name, baseUrl)
    return readFileSync(full, 'utf8')
  }).join('\n')
}
