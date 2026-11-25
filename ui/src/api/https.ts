// HTTPS certificate for the web UI: Let's Encrypt by DNS-01 through Cloudflare (acme.sh, UCI
// 'acme' section 'er4'); <host>.<domain> resolves to the router's LAN address (dhcp.er4_https).
//   er4.acme_status -> AcmeStatus      er4.acme_setup {domain, host, email, token?} -> {} | {error}
//   er4.acme_renew -> {}               er4.acme_off -> {}
import { api } from './client'

export interface AcmeCert { issuer: string; names: string[]; not_before?: string; not_after?: string; days?: number | null }
export interface AcmeStatus {
  installed: boolean
  config?: { domain: string; host: string; email: string; token_set: boolean } | null
  running?: boolean; cert?: AcmeCert | null; serving?: boolean; lan?: string | null; log?: string[]
}
export interface AcmeSettings { domain: string; host: string; email: string; token?: string }

async function checked<T>(p: Promise<T | { error: string }>): Promise<T> {
  const r = await p
  if (r && typeof r === 'object' && 'error' in r) throw new Error(r.error)
  return r as T
}

export const https = {
  status: () => api.call<AcmeStatus>('er4', 'acme_status'),
  setup: (s: AcmeSettings) => checked(api.call<object | { error: string }>('er4', 'acme_setup', { ...s })),
  renew: () => checked(api.call<object | { error: string }>('er4', 'acme_renew')),
  off: () => api.call<object>('er4', 'acme_off'),
}

export const domainOk = (d: string) => /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d)
export const hostOk = (h: string) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(h)
export const emailOk = (e: string) => /^[^@\s"'`$\\]+@[^@\s"'`$\\]+\.[^@\s"'`$\\]+$/.test(e)
export const tokenOk = (t: string) => /^[A-Za-z0-9_-]{20,128}$/.test(t)
