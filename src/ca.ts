// The hub's own certificate authority, so devices reach it over HTTPS without
// any public CA, ACME or certificate-transparency log. The CA is name
// constrained to the hub's own names and addresses: even a stolen CA key cannot
// sign a certificate for any other site. Uses the openssl CLI.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { tool } from './platform.ts'
import { promisify } from 'node:util'

const run = (args: string[]) => promisify(execFile)(tool('openssl'), args, { timeout: 30_000, windowsHide: true })

// Apple caps certificates from user-installed roots at 825 days; stay well under.
const SERVER_DAYS = 397
const RENEW_BEFORE_MS = 30 * 24 * 3600_000

// legacy: the previous CA's server certificate and key, still served to devices
// that trust only that CA (see ensureCa) until it is retired.
export type CaFiles = { dir: string; caKey: string; caCert: string; key: string; cert: string; legacy: { dir: string; caCert: string; key: string; cert: string } }

export function caFiles(dir: string): CaFiles {
  const legacy = path.join(dir, 'legacy')
  return {
    dir,
    caKey: path.join(dir, 'ca.key'),
    caCert: path.join(dir, 'ca.crt'),
    key: path.join(dir, 'server.key'),
    cert: path.join(dir, 'server.crt'),
    legacy: { dir: legacy, caCert: path.join(legacy, 'ca.crt'), key: path.join(legacy, 'server.key'), cert: path.join(legacy, 'server.crt') },
  }
}

export function hasLegacy(files: CaFiles) {
  return fs.existsSync(files.legacy.cert) && fs.existsSync(files.legacy.key)
}

// Whether a CA's constraints permit every name and address (a DNS constraint
// covers the name and its subdomains; an IP constraint here is always one address).
export async function covers(certFile: string, names: string[], ips: string[]) {
  const permitted = await permittedNames(certFile)
  const stdout = await nameConstraints(certFile)
  const addresses = [...stdout.matchAll(/IP:([0-9a-fA-F.:]+)\//g)].map((m) => m[1]!.toLowerCase())
  return names.every((n) => permitted.some((p) => n.toLowerCase() === p || n.toLowerCase().endsWith(`.${p}`))) && ips.every((ip) => addresses.includes(ip.toLowerCase()))
}

// The certificate's name constraints as openssl prints them. From the full text, not -ext:
// macOS ships LibreSSL, which has no -ext.
async function nameConstraints(certFile: string) {
  const { stdout } = await run(['x509', '-noout', '-text', '-in', certFile])
  return /X509v3 Name Constraints[^\n]*\n([\s\S]*?)(?=\n\s*(?:X509v3 |Signature Algorithm|Authority|Subject Key)|$)/.exec(stdout)?.[1] ?? ''
}

// The addresses among ips that the CA's name constraints allow in a certificate.
export async function signableIps(certFile: string, ips: string[]) {
  const stdout = await nameConstraints(certFile)
  const addresses = [...stdout.matchAll(/IP:([0-9a-fA-F.:]+)\//g)].map((m) => m[1]!.toLowerCase())
  return ips.filter((ip) => addresses.includes(ip.toLowerCase()))
}

function ipConstraint(ip: string) {
  return ip.includes(':') ? `IP:${ip}/ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff` : `IP:${ip}/255.255.255.255`
}

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vocorum-ca-'))
  try {
    return await fn(dir)
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
}

// The DNS names a CA's name constraint permits.
export async function permittedNames(certFile: string): Promise<string[]> {
  const stdout = await nameConstraints(certFile)
  return [...stdout.matchAll(/DNS:([^\s,]+)/g)].map((m) => m[1]!.toLowerCase())
}

// Zones private by definition: a constraint to one of them can never cover a public site.
const PRIVATE_ZONES = ['home.arpa', 'internal', 'lan', 'local']

// Constraint entries broader than the hub's names: a whole zone that may be a
// public suffix (ts.net, co.uk). Older hubs made such CAs.
export async function broadConstraints(certFile: string, names: string[]): Promise<string[]> {
  const wanted = names.map((n) => n.toLowerCase())
  return (await permittedNames(certFile)).filter((entry) => !wanted.includes(entry) && !PRIVATE_ZONES.some((zone) => entry === zone || entry.endsWith(`.${zone}`)))
}

// reissueBroad: replace a CA whose constraint is too broad (the old one is
// kept aside); devices must then install the new profile. Otherwise it only warns.
export async function ensureCa(files: CaFiles, { names, ips, reissueBroad = false }: { names: string[]; ips: string[]; reissueBroad?: boolean }): Promise<{ broad: string[]; reissued: boolean; rotated?: boolean }> {
  if (fs.existsSync(files.caKey) && fs.existsSync(files.caCert)) {
    const broad = await broadConstraints(files.caCert, names)
    // A name the CA may not sign (one was added): a new CA for all of them. Its old
    // server certificate keeps serving the old names, so devices that trust the old CA
    // go on working until "private retire-legacy". A new address alone does not: the
    // hub on another computer keeps its CA, and its certificate names only what the
    // CA may sign (devices reach it by name). See signableIps.
    if (broad.length === 0 && !(await covers(files.caCert, names, []))) {
      if (!hasLegacy(files)) {
        await fs.promises.mkdir(files.legacy.dir, { recursive: true, mode: 0o700 })
        for (const [from, to] of [[files.caCert, files.legacy.caCert], [files.cert, files.legacy.cert], [files.key, files.legacy.key]] as const) if (fs.existsSync(from)) await fs.promises.rename(from, to)
      } else {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        for (const file of [files.caCert, files.cert, files.key]) if (fs.existsSync(file)) await fs.promises.rename(file, `${file}.old-${stamp}`)
      }
      await fs.promises.rm(files.caKey, { force: true })
      await createCa(files, { names, ips })
      return { broad, reissued: true, rotated: true }
    }
    if (broad.length === 0) return { broad, reissued: false }
    if (!reissueBroad) {
      console.warn(`[vocorum] The hub's CA may sign any name under ${broad.join(', ')}. Run "vocorum private setup" again to replace it with one limited to ${names.join(', ')}.`)
      return { broad, reissued: false }
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    for (const file of [files.caKey, files.caCert, files.cert, files.key]) if (fs.existsSync(file)) await fs.promises.rename(file, `${file}.old-${stamp}`)
    await createCa(files, { names, ips })
    return { broad, reissued: true }
  }
  await createCa(files, { names, ips })
  return { broad: [], reissued: false }
}

async function createCa(files: CaFiles, { names, ips }: { names: string[]; ips: string[] }) {
  await fs.promises.mkdir(files.dir, { recursive: true, mode: 0o700 })
  // Exactly the hub's own names (a DNS constraint also covers their
  // subdomains) and address: never a whole zone, which could be a public
  // suffix such as ts.net or co.uk.
  const permitted = [...[...new Set(names)].map((name) => `DNS:${name}`), ...ips.map(ipConstraint)].map((entry) => `permitted;${entry}`).join(',')
  const id = crypto.randomBytes(4).toString('hex')
  await run([
    'req', '-x509', '-new', '-nodes',
    '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-pkeyopt', 'ec_param_enc:named_curve',
    '-keyout', files.caKey, '-out', files.caCert,
    '-days', '3650', '-sha256',
    '-subj', `/CN=Vocorum local CA ${id}`,
    '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
    '-addext', `nameConstraints=critical,${permitted}`,
  ])
  await fs.promises.chmod(files.caKey, 0o600)
}

// Issues or renews the server certificate when missing, close to expiry, or
// when the names or addresses changed.
export async function ensureServerCert(files: CaFiles, { names, ips }: { names: string[]; ips: string[] }) {
  const want = [...names.map((n) => `DNS:${n}`), ...ips.map((ip) => `IP Address:${ip}`)].map((s) => s.toLowerCase()).sort().join(',')
  if (fs.existsSync(files.cert) && fs.existsSync(files.key)) {
    const cert = new crypto.X509Certificate(fs.readFileSync(files.cert))
    const have = (cert.subjectAltName ?? '').split(', ').map((s) => s.toLowerCase()).sort().join(',')
    const fresh = new Date(cert.validTo).getTime() - Date.now() > RENEW_BEFORE_MS
    const signedByCa = cert.checkIssued(new crypto.X509Certificate(fs.readFileSync(files.caCert)))
    if (fresh && signedByCa && have === want) return false
  }
  await withTemp(async (tmp) => {
    const csr = path.join(tmp, 'server.csr')
    const ext = path.join(tmp, 'ext.cnf')
    const san = [...names.map((n) => `DNS:${n}`), ...ips.map((ip) => `IP:${ip}`)].join(',')
    await fs.promises.writeFile(ext, `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=${san}\n`)
    await run(['req', '-new', '-nodes', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-pkeyopt', 'ec_param_enc:named_curve', '-keyout', files.key, '-out', csr, '-subj', `/CN=${names[0] ?? ips[0]}`])
    await run(['x509', '-req', '-in', csr, '-CA', files.caCert, '-CAkey', files.caKey, '-CAcreateserial', '-out', files.cert, '-days', String(SERVER_DAYS), '-sha256', '-extfile', ext])
  })
  await fs.promises.chmod(files.key, 0o600)
  await fs.promises.rm(path.join(files.dir, 'ca.srl'), { force: true })
  return true
}

export function fingerprint(certFile: string) {
  return new crypto.X509Certificate(fs.readFileSync(certFile)).fingerprint256
}

export function certDer(certFile: string) {
  return new crypto.X509Certificate(fs.readFileSync(certFile)).raw
}
