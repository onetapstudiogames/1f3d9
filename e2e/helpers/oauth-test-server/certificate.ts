import { spawnSync } from 'node:child_process'

function makeCertificate(): { key: string; cert: string } {
  const generated = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', '-',
    '-out', '-',
    '-days', '1',
    '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
  ], { encoding: 'utf8' })
  if (generated.status !== 0) {
    throw new Error(`Could not create the disposable E2E certificate: ${generated.stderr}`)
  }
  const key = generated.stdout.match(
    /-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA )?PRIVATE KEY-----/,
  )?.[0]
  const cert = generated.stdout.match(
    /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/,
  )?.[0]
  if (!key || !cert) throw new Error('OpenSSL returned an incomplete disposable E2E certificate')
  return { key, cert }
}

export { makeCertificate }
