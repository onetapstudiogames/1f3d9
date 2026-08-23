import { pathToFileURL } from 'node:url'
import { verifySnapshotDirectory } from '../src/public-snapshot-format.ts'

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2)
  if (arguments_.length !== 2 || arguments_[0] !== '--dir' || !arguments_[1]) {
    throw new Error('Usage: npm run snapshot:verify -- --dir <downloaded-snapshot-directory>')
  }
  const verified = await verifySnapshotDirectory(arguments_[1])
  console.log(JSON.stringify({
    verified: true,
    snapshot: verified.tag,
    city_root_sha256: verified.city_root_sha256,
    files: verified.files.length,
    counts: verified.counts,
  }))
}

const entrypoint = process.argv[1]
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'public snapshot verification failed')
    process.exitCode = 1
  })
}
