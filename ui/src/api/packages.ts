// The official packages behind optional features (Tailscale, IPsec, the HTTPS certificate),
// installed and upgraded with apk by the router in the background:
//   er4.packages                              -> Packages
//   er4.pkg_install / pkg_upgrade {feature}   -> {} | {error}
import { api } from './client'

export type Feature = 'tailscale' | 'ipsec' | 'acme'
/** ok: apk succeeded (its exit code alone can't tell when an older package is left broken) */
export interface PkgJob { action: 'install' | 'upgrade'; feature: Feature; running: boolean; rc: number | null; ok: boolean; log: string[] }
export type Packages = Record<Feature, boolean> & { job: PkgJob | null }

async function checked(p: Promise<object | { error: string }>) {
  const r = await p
  if (r && 'error' in r) throw new Error(r.error)
}

export const packages = {
  status: () => api.call<Packages>('er4', 'packages'),
  install: (feature: Feature) => checked(api.call('er4', 'pkg_install', { feature })),
  upgrade: (feature: Feature) => checked(api.call('er4', 'pkg_upgrade', { feature })),
}
