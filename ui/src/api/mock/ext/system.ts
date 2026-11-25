// System mocks: password, clock, firmware A/B updates, config backup/restore, reboot.
//
// Available on the router already (mocked here with the same reply shapes):
//   er4.set_password {username, password}  -> {result}       ER-4 plugin (was luci.setPassword)
//   er4.setup_status {}                     -> {password_set}  first boot, before login
//   er4.setup_password {password}           -> {result, error?} only while no password is set
//   er4.timezones {}                        -> {zone: {tzstring, active?}}
//   er4.set_localtime {localtime}           -> {result}
//   uci.configs {}                          -> {configs: [...]}  rpcd built-in
//   uploads: POST /cgi-bin/cgi-upload (sessionid, filename, filemode, filedata), cgi-io
//   backup:  POST /cgi-bin/cgi-backup (sessionid) -> sysupgrade -b tar.gz, cgi-io
//
// er4 plugin, firmware: OpenWrt's sysupgrade.
//   er4.firmware_info {}  -> {release, board, model, kernel, hooks}
//   er4.firmware_verify {path} -> {valid, checks: [{id, label, ok: true|false|null, detail}], image?: {size, sha256}}
//        (board, sysupgrade -T, the Octeon offload driver hooks, sha256)
//   er4.firmware_install {path, keep} -> {} | {error}; sysupgrade [-n], then the router reboots
//   er4.reboot {} -> {}; reboots two seconds after it answers
//   er4.config_inspect {path} -> {valid, hostname?, version?, created?, files[], error?}
//        (lists a sysupgrade -b archive before restoring it)
//   er4.config_restore {path} -> {}; sysupgrade -r <path>, then reboots
//   er4.factory_reset {} -> {}; firstboot -y && reboot (wipes the overlay of the running slot)
//   er4.acme_status / acme_setup / acme_renew / acme_off: HTTPS certificate (api/https.ts); issuing
//        takes ~6 s here, then the certificate is served
//
// Scenarios (../scenario.ts): verify-fail, slow,
// no-password (first-boot setup on the login page), https-fail.
// A reboot (er4.reboot, firmware_install, config_restore, factory_reset) makes every call
// fail for ~8 s, like the real router going away.
import { UBUS_STATUS, UbusError } from '../../ubus'
import { mockUci, objects, registerMock } from '../registry'
import { scenario, wrapMock } from '../scenario'
import { parseSshKey } from '../../system'

/** Names of files "uploaded" to the mock, by router path (set by api/system.ts upload()). */
export const mockFiles: Record<string, string> = {}

const DAY = 86400
const now = () => Math.round(Date.now() / 1000)

let verified = false // a checked image sits in /tmp/firmware.bin
let rebootUntil = 0
let rebootAt = 0

function reboot() {
  rebootUntil = Date.now() + 8000
  rebootAt = rebootUntil
}

const TZ: Record<string, string> = {
  UTC: 'UTC0', 'Africa/Johannesburg': 'SAST-2', 'Africa/Lagos': 'WAT-1', 'America/Anchorage': 'AKST9AKDT,M3.2.0,M11.1.0',
  'America/Chicago': 'CST6CDT,M3.2.0,M11.1.0', 'America/Denver': 'MST7MDT,M3.2.0,M11.1.0', 'America/Los_Angeles': 'PST8PDT,M3.2.0,M11.1.0',
  'America/Mexico_City': 'CST6', 'America/New_York': 'EST5EDT,M3.2.0,M11.1.0', 'America/Sao_Paulo': '<-03>3', 'America/Toronto': 'EST5EDT,M3.2.0,M11.1.0',
  'America/Vancouver': 'PST8PDT,M3.2.0,M11.1.0', 'Asia/Bangkok': '<+07>-7', 'Asia/Dubai': '<+04>-4', 'Asia/Hong_Kong': 'HKT-8', 'Asia/Jerusalem': 'IST-2IDT,M3.4.4/26,M10.5.0',
  'Asia/Kolkata': 'IST-5:30', 'Asia/Seoul': 'KST-9', 'Asia/Shanghai': 'CST-8', 'Asia/Singapore': '<+08>-8', 'Asia/Tokyo': 'JST-9',
  'Atlantic/Reykjavik': 'GMT0', 'Australia/Adelaide': 'ACST-9:30ACDT,M10.1.0,M4.1.0/3', 'Australia/Brisbane': 'AEST-10', 'Australia/Perth': 'AWST-8',
  'Australia/Sydney': 'AEST-10AEDT,M10.1.0,M4.1.0/3', 'Europe/Amsterdam': 'CET-1CEST,M3.5.0,M10.5.0/3', 'Europe/Athens': 'EET-2EEST,M3.5.0/3,M10.5.0/4',
  'Europe/Berlin': 'CET-1CEST,M3.5.0,M10.5.0/3', 'Europe/Brussels': 'CET-1CEST,M3.5.0,M10.5.0/3', 'Europe/Dublin': 'IST-1GMT0,M10.5.0,M3.5.0/1',
  'Europe/Helsinki': 'EET-2EEST,M3.5.0/3,M10.5.0/4', 'Europe/Istanbul': '<+03>-3', 'Europe/Lisbon': 'WET0WEST,M3.5.0/1,M10.5.0', 'Europe/London': 'GMT0BST,M3.5.0/1,M10.5.0',
  'Europe/Madrid': 'CET-1CEST,M3.5.0,M10.5.0/3', 'Europe/Moscow': 'MSK-3', 'Europe/Oslo': 'CET-1CEST,M3.5.0,M10.5.0/3', 'Europe/Paris': 'CET-1CEST,M3.5.0,M10.5.0/3',
  'Europe/Prague': 'CET-1CEST,M3.5.0,M10.5.0/3', 'Europe/Rome': 'CET-1CEST,M3.5.0,M10.5.0/3', 'Europe/Stockholm': 'CET-1CEST,M3.5.0,M10.5.0/3',
  'Europe/Vienna': 'CET-1CEST,M3.5.0,M10.5.0/3', 'Europe/Warsaw': 'CET-1CEST,M3.5.0,M10.5.0/3', 'Europe/Zurich': 'CET-1CEST,M3.5.0,M10.5.0/3',
  'Pacific/Auckland': 'NZST-12NZDT,M9.5.0,M4.1.0/3', 'Pacific/Honolulu': 'HST10',
}

// procd init scripts (rc list / rc init): running is left out for one-shot scripts
const rc: Record<string, { start: number; stop?: number; enabled: boolean; running?: boolean }> = {
  boot: { start: 10, stop: 10, enabled: true }, cron: { start: 50, enabled: false, running: false },
  dnsmasq: { start: 19, stop: 10, enabled: true, running: true }, done: { start: 95, enabled: true },
  dropbear: { start: 19, stop: 50, enabled: true, running: true }, firewall: { start: 19, enabled: true, running: true },
  gpio_switch: { start: 98, enabled: true }, led: { start: 96, enabled: true }, log: { start: 12, enabled: true, running: true },
  network: { start: 20, stop: 90, enabled: true, running: true }, odhcpd: { start: 35, stop: 85, enabled: true, running: true },
  offload: { start: 21, enabled: true, running: true }, packet_steering: { start: 25, enabled: true },
  rpcd: { start: 12, enabled: true, running: true }, sysctl: { start: 11, enabled: true },
  swanctl: { start: 90, stop: 10, enabled: false, running: false },
  sysfixtime: { start: 0, enabled: true }, sysntpd: { start: 98, enabled: true, running: true },
  system: { start: 10, enabled: true }, uhttpd: { start: 50, enabled: true, running: true },
  umount: { stop: 90, start: 0, enabled: true }, urandom_seed: { start: 99, enabled: true }, urngd: { start: 0, enabled: true, running: true },
}
registerMock('rc', {
  list: () => JSON.parse(JSON.stringify(rc)),
  init: ({ name, action }) => {
    const s = rc[String(name)]
    if (!s) throw new UbusError('rc', 'init', UBUS_STATUS.NOT_FOUND)
    if (!['start', 'stop', 'restart', 'reload', 'enable', 'disable'].includes(String(action))) throw new UbusError('rc', 'init', UBUS_STATUS.INVALID_ARGUMENT)
    if (action === 'enable' || action === 'disable') s.enabled = action === 'enable'
    else if (s.running !== undefined) s.running = action !== 'stop'
    return {}
  },
})

// root's authorized_keys (er4.ssh_keys / ssh_keys_set)
let sshKeys: string[] = ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK3m0ckPubKeyForTheMockRouterOnlyAAAAAAAAAA admin@desktop']
registerMock('er4', {
  ssh_keys: () => ({ keys: sshKeys.map((l) => parseSshKey(l)!).filter(Boolean) }),
  ssh_keys_set: ({ keys }) => {
    if (!Array.isArray(keys) || keys.length > 64) return { error: 'bad arguments' }
    for (const l of keys) if (typeof l !== 'string' || l.includes('\n') || !parseSshKey(l)) return { error: `not a public key: ${String(l).slice(0, 40)}` }
    sshKeys = keys.map((l) => (l as string).trim())
    return { keys: sshKeys.map((l) => parseSshKey(l)!) }
  },
})

// no-password: like the patched rpcd, no login works until setup_password sets one
let passwordSet = false
wrapMock('session', 'login', (orig) => (args) => {
  if (scenario('no-password') && !passwordSet) throw new UbusError('session', 'login', UBUS_STATUS.PERMISSION_DENIED)
  return orig(args)
})
registerMock('er4', {
  setup_status: () => ({ password_set: passwordSet || !scenario('no-password') }),
  setup_password: ({ password }) => {
    if (passwordSet || !scenario('no-password')) return { result: false, error: 'a password is already set' }
    if (typeof password !== 'string' || password.length < 8 || password.includes('\n')) return { result: false, error: 'bad password' }
    passwordSet = true
    return { result: true }
  },
  // the router answers {result: false} (not a ubus error) for an unknown user or a bad password
  set_password: ({ username, password }) => ({ result: username === 'root' && typeof password === 'string' && !!password && !password.includes('\n') }),
  timezones: () => {
    const active = String(Object.values(mockUci.live.system ?? {}).find((x) => x['.type'] === 'system')?.zonename ?? 'UTC')
    return Object.fromEntries(Object.entries(TZ).map(([k, v]) => [k, k === active ? { tzstring: v, active: true } : { tzstring: v }]))
  },
  set_localtime: ({ localtime }) => {
    clockSkew = Number(localtime) - Date.now() / 1000
    return { result: true }
  },
})

// The mock router's clock runs 47 s late until "Sync with browser" (set_localtime)
let clockSkew = -47
wrapMock('system', 'info', (orig) => async (args) => {
  const r = (await orig(args)) as { localtime: number; uptime: number }
  // rpcd: localtime = UTC epoch + the zone's offset (wall clock)
  const zone = String(Object.values(mockUci.live.system ?? {}).find((x) => x['.type'] === 'system')?.zonename ?? 'UTC')
  const d = new Date(); d.setMilliseconds(0)
  let off = 0
  try { off = (new Date(d.toLocaleString('en-US', { timeZone: zone })).getTime() - new Date(d.toLocaleString('en-US', { timeZone: 'UTC' })).getTime()) / 1000 } catch { /* unknown zone */ }
  r.localtime = Math.round(Date.now() / 1000 + clockSkew + off)
  if (rebootAt) r.uptime = Math.round((Date.now() - rebootAt) / 1000) + 40
  return r
})

registerMock('uci', {
  configs: () => ({ configs: Object.keys(mockUci.live).concat(['dropbear', 'rpcd', 'ucitrack', 'uhttpd']).sort() }),
})

registerMock('er4', {
  firmware_info: () => ({
    release: { id: 'OpenWrt', release: '25.12.6', revision: 'r33311-981c978eff', description: 'OpenWrt 25.12.6 r33311-981c978eff' },
    board: 'ubnt,edgerouter-4', model: 'Ubiquiti EdgeRouter 4', kernel: '6.12.112', hooks: true,
  }),

  // a .tar named like a sysupgrade image passes; "openwrt-25…" without "offload" stands for an
  // official build (no driver hooks)
  firmware_verify: async ({ path }) => {
    await new Promise((r) => setTimeout(r, 1100))
    const name = mockFiles[String(path)]
    if (!name) return { error: 'no image uploaded' }
    const tar = /sysupgrade.*\.tar$/i.test(name) && !scenario('verify-fail')
    const hooks = /offload/i.test(name)
    const sha256 = '1aaff0fb76917e7bce031e6dbb970a8798ed5284ea100d98f133e4f126046b59'
    const checks = [
      { id: 'board', label: 'Built for ubnt,edgerouter-4', ok: tar, detail: tar ? 'contains sysupgrade-ubnt_edgerouter-4/' : 'not a sysupgrade image (.tar)' },
      { id: 'sysupgrade', label: 'sysupgrade accepts it', ok: tar, detail: tar ? 'Image metadata not present' : 'Image check failed.' },
      ...(tar ? [{ id: 'offload', label: 'Has the Octeon offload driver hooks (patch 703)', ok: hooks, detail: hooks ? 'hardware offload keeps working' : 'an official build: it works, but nothing is offloaded in hardware' }] : []),
      { id: 'sha256', label: 'SHA-256', ok: null, detail: sha256 },
    ]
    verified = tar
    return { valid: tar, checks, image: { size: 16076800, sha256 } }
  },

  firmware_install: () => {
    if (!verified) return { error: 'sysupgrade refuses this image' }
    verified = false
    setTimeout(reboot, 2000)
    return {}
  },

  config_inspect: async ({ path }) => {
    await new Promise((r) => setTimeout(r, 700))
    const name = mockFiles[String(path)]
    if (!name) return { valid: false, files: [], error: `${path} not found` }
    if (!/\.(tar\.gz|tgz)$/i.test(name)) return { valid: false, files: [], error: 'Not a sysupgrade backup (expected a .tar.gz from "Download backup")' }
    return {
      valid: true, hostname: 'er4', version: '25.12.4', created: now() - 12 * DAY,
      files: ['etc/config/dhcp', 'etc/config/dropbear', 'etc/config/firewall', 'etc/config/network', 'etc/config/offload', 'etc/config/system', 'etc/config/uhttpd', 'etc/dropbear/authorized_keys', 'etc/group', 'etc/passwd', 'etc/shadow', 'etc/sysupgrade.conf'],
    }
  },
  reboot: () => { setTimeout(reboot, 300); return {} },
  config_restore: () => { setTimeout(reboot, 300); return {} },
  factory_reset: () => { setTimeout(reboot, 300); return {} },
})


// While "rebooting", the router is unreachable (like a fetch that fails)
queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => {
  for (const [obj, methods] of Object.entries(objects)) {
    for (const [m, fn] of Object.entries(methods)) {
      methods[m] = (a) => {
        if (Date.now() < rebootUntil) {
          throw new UbusError(obj, m, -1, 'router unreachable (rebooting)')
        }
        return fn(a)
      }
    }
  }
})))

// root's crontab (er4.crontab / crontab_set)
let cron = ''
const CRON_FIELD = /^(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*$/
registerMock('er4', {
  crontab: () => ({ text: cron, enabled: rc.cron.enabled, running: !!rc.cron.running }),
  crontab_set: ({ text }) => {
    if (typeof text !== 'string') return { error: 'bad arguments' }
    const lines = text.split('\n')
    for (const [i, l] of lines.entries()) {
      const t = l.trim()
      if (!t || t.startsWith('#')) continue
      const f = t.split(/\s+/)
      if (f.length < 6 || f.slice(0, 5).some((x) => !CRON_FIELD.test(x))) return { error: 'not a cron line', line: i + 1 }
    }
    cron = text.trim() ? `${text.trim()}\n` : ''
    const any = lines.some((l) => l.trim() && !l.trim().startsWith('#'))
    rc.cron.enabled = any
    rc.cron.running = any
    return {}
  },
})

// ---- HTTPS certificate (er4.acme_*) -------------------------------------------------------------
let acme: { domain: string; host: string; email: string; since: number; issued?: string } | undefined
const acmeLog = (a: NonNullable<typeof acme>, t: number) => {
  const at = (s: number) => new Date((a.since + s) * 1000).toString().slice(4, 24)
  const l = [`${at(0)} daemon.info acme: Running ACME for ${a.domain} with validation_method dns`,
    `${at(1)} daemon.info acme-acmesh: Adding TXT value: … for domain: _acme-challenge.${a.domain}`]
  if (scenario('https-fail')) return t < 3 ? l : [...l, `${at(3)} daemon.err acme-acmesh: invalid domain`,
    `${at(3)} daemon.err acme-acmesh: Error add txt for domain:_acme-challenge.${a.domain}`, `${at(3)} daemon.err acme: State moved to /etc/acme/${a.domain}_ecc.failed-${a.since + 3}`]
  return t < 6 ? l : [...l, `${at(5)} daemon.info acme-acmesh: Success`, `${at(6)} daemon.info acme-acmesh: Cert success.`]
}
// optional features' packages (all installed in the mock) and the Software page
type MockPkg = { name: string; version: string; description: string; size: number; world: boolean; upgrade: string | null }
const mockPkgs: MockPkg[] = [
  ['base-files', '1718~981c978eff', 'This package contains a base filesystem and system scripts for OpenWrt.', 49492, true, null],
  ['busybox', '1.37.0-r6', 'The Swiss Army Knife of embedded Linux.', 512000, true, null],
  ['dnsmasq', '2.91-r1', 'A lightweight DNS and DHCP server.', 302000, true, '2.91-r2'],
  ['er4-ui', '0.3.0-r2', 'Dense single-page admin UI (Preact app at /er4/) and the rpcd plugin "er4".', 647755, true, null],
  ['kmod-octeon-offload', '6.12.112-r5', 'Forwards established flows in the Octeon ethernet driver\'s receive path.', 32792, true, null],
  ['libpcap1', '1.10.6-r1', 'This package contains the libpcap shared library.', 232000, false, null],
  ['tcpdump-mini', '4.99.6-r1', 'Network monitoring and data acquisition tool (minimal version)', 454929, true, null],
  ['wireguard-tools', '1.0.20260223-r1', 'WireGuard is a novel VPN that runs inside the Linux Kernel.', 120000, true, null],
].map(([name, version, description, size, world, upgrade]) => ({ name, version, description, size, world, upgrade }) as MockPkg)
const mockRepo = [
  ['htop', '3.4.1-r1', 'Htop is an ncursed-based process viewer similar to top, but it allows to scroll the list vertically and horizontally.', 98000],
  ['iperf3', '3.19-r1', 'Iperf is a modern alternative for measuring TCP and UDP bandwidth performance.', 41000],
  ['luci-app-sqm', '26.326.69129~cb87fe6', 'Control the simple_qos SQM script', 9000],
  ['sqm-scripts', '1.6.0-r1', 'A queue setup script for traffic shaping.', 22000],
  ['tcpdump', '4.99.6-r1', 'Network monitoring and data acquisition tool', 330000],
] as const
let mockJob: { action: string; feature: string | null; packages: string[]; running: boolean; rc: number | null; ok: boolean; log: string[] } | null = null
function startJob(action: string, packages: string[]) {
  if (mockJob?.running) return { error: 'another package job is still running' }
  mockJob = { action, feature: null, packages, running: true, rc: null, ok: false, log: ['fetch https://downloads.openwrt.org/releases/25.12.6/…/packages.adb'] }
  const j = mockJob
  setTimeout(() => {
    j.running = false; j.rc = 0; j.ok = true
    j.log.push(...packages.map((p, i) => `(${i + 1}/${packages.length}) ${action === 'del' ? 'Purging' : 'Installing'} ${p}`), 'OK: 13.7 MiB in 158 packages')
    for (const p of packages) {
      const i = mockPkgs.findIndex((x) => x.name === p)
      const r = mockRepo.find((x) => x[0] === p)
      if (action === 'del' && i >= 0) mockPkgs.splice(i, 1)
      else if (action === 'add' && i < 0 && r) mockPkgs.push({ name: r[0], version: r[1], description: r[2], size: r[3] * 2, world: true, upgrade: null })
      else if (action === 'upgrade' && i >= 0 && mockPkgs[i].upgrade) mockPkgs[i] = { ...mockPkgs[i], version: mockPkgs[i].upgrade!, upgrade: null }
    }
    if (action === 'upgrade-all') for (const p of mockPkgs) if (p.upgrade) { p.version = p.upgrade; p.upgrade = null }
  }, 2500)
  return {}
}
// pkgs-none: the optional features' packages are missing until pkg_install (about 4 s)
const featureAt: Record<string, number> = {}
export const featureInstalled = (f: string) => !scenario('pkgs-none') || (featureAt[f] != null && Date.now() - featureAt[f] > 4000)
registerMock('er4', {
  packages: () => {
    const f = Object.entries(featureAt).find(([k]) => !featureInstalled(k))
    const done = Object.keys(featureAt).sort((a, b) => featureAt[b] - featureAt[a])[0]
    const job = f ? { action: 'install', feature: f[0], packages: [], running: true, rc: null, ok: false, log: [`(${Math.ceil((Date.now() - f[1]) / 500)}/9) Installing strongswan-mod-…`] }
      : done ? { action: 'install', feature: done, packages: [], running: false, rc: 1, ok: true, log: ['1 error; 22.3 MiB in 236 packages'] } : null
    return { wireguard: featureInstalled('wireguard'), tailscale: featureInstalled('tailscale'), ipsec: featureInstalled('ipsec'), acme: featureInstalled('acme'), capture: featureInstalled('capture'), job }
  },
  pkg_install: ({ feature }) => { featureAt[String(feature)] ??= Date.now(); return {} },
  pkg_upgrade: () => ({}),
  pkg_list: () => ({ packages: mockPkgs.map((p) => ({ ...p })), updated: now() - 3600, job: mockJob }),
  pkg_search: ({ query }) => {
    const q = String(query ?? '').toLowerCase()
    if (q.length < 2) return { packages: [], more: false }
    const all = [...mockRepo.map(([name, version, description, size]) => ({ name, version, description, size })), ...mockPkgs.map((p) => ({ name: p.name, version: p.upgrade ?? p.version, description: p.description, size: p.size / 2 }))]
    return { packages: all.filter((p) => p.name.includes(q) || p.description.toLowerCase().includes(q))
      .map((p) => ({ ...p, installed: mockPkgs.find((x) => x.name === p.name)?.version ?? null })), more: false }
  },
  pkg_info: ({ name }) => {
    const i = mockPkgs.find((x) => x.name === name)
    const r = mockRepo.find((x) => x[0] === name)
    if (!i && !r) return { error: 'no such package' }
    return { name, version: i?.upgrade ?? i?.version ?? r![1], description: i?.description ?? r![2], license: 'GPL-2.0', url: 'https://openwrt.org/',
      size: i?.size ?? r![3] * 2, download: (i?.size ?? r![3] * 2) / 2, depends: name === 'tcpdump-mini' ? ['libc', 'libpcap1'] : ['libc'],
      required_by: name === 'libpcap1' ? ['tcpdump-mini'] : [], installed: i?.version ?? null, world: !!i?.world }
  },
  pkg_action: ({ action, packages }) => startJob(String(action), Array.isArray(packages) ? packages.map(String) : []),
  pkg_job: () => mockJob ?? {},
})

registerMock('er4', {
  acme_status: () => {
    if (!featureInstalled('acme')) return { installed: false }
    if (!acme) return { installed: true, config: null, running: false, cert: null, serving: false, lan: '192.168.1.1', log: [] }
    const t = Date.now() / 1000 - acme.since
    const ok = !scenario('https-fail') && t >= 6
    if (ok) acme.issued ??= acme.domain
    const cert = acme.issued ? { issuer: "Let's Encrypt", names: [acme.issued, `*.${acme.issued}`], not_before: 'Oct 20 23:10:04 2026 GMT', not_after: 'Jan 18 23:10:03 2027 GMT', days: 89 } : null
    return { installed: true, config: { domain: acme.domain, host: acme.host, email: acme.email, token_set: true },
      running: scenario('https-fail') ? t < 3 : t < 6, cert: acme.issued === acme.domain ? cert : null, serving: acme.issued === acme.domain, lan: '192.168.1.1', log: acmeLog(acme, t) }
  },
  acme_setup: ({ domain, host, email, token }) => {
    if (typeof domain !== 'string' || !/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) return { error: 'a domain name like example.com' }
    if (!acme && !token) return { error: 'the Cloudflare API token is missing' }
    acme = { domain, host: String(host), email: String(email), since: Date.now() / 1000, issued: acme?.issued }
    return {}
  },
  acme_renew: () => { if (acme) acme.since = Date.now() / 1000; return {} },
  acme_off: () => { acme = undefined; return {} },
})
