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

// ---- the Software page (System > Software) ---------------------------------------------------
//   er4.pkg_list                    -> PkgList      installed packages
//   er4.pkg_search {query}          -> {packages: PkgFound[], more}
//   er4.pkg_info {name}             -> PkgInfo
//   er4.pkg_action {action, packages?} -> {} | {error}   (the package job)
//   er4.pkg_job {lines}             -> PkgJob | {}    (with more of the log)
export const PKG_UPLOAD = '/tmp/er4-upload.apk'
export interface PkgInstalled { name: string; version: string; description?: string; size: number; world: boolean; upgrade: string | null }
export interface PkgList { packages: PkgInstalled[]; updated: number; job: PkgJob | null }
export interface PkgFound { name: string; version: string; description?: string; size: number; installed: string | null }
export interface PkgInfo {
  name: string; version: string; description?: string; url?: string; license?: string
  size: number; download: number; depends: string[]; required_by: string[]; installed: string | null; world: boolean
}
export type PkgAction = 'add' | 'del' | 'upgrade' | 'upgrade-all' | 'update' | 'add-file'
export interface SoftwareJob extends Omit<PkgJob, 'action' | 'feature'> { action: PkgAction | 'install'; feature: Feature | null; packages: string[] }

export const software = {
  list: () => api.call<PkgList>('er4', 'pkg_list'),
  search: (query: string) => api.call<{ packages: PkgFound[]; more: boolean }>('er4', 'pkg_search', { query }),
  info: async (name: string) => {
    const r = await api.call<PkgInfo | { error: string }>('er4', 'pkg_info', { name })
    if ('error' in r) throw new Error(r.error)
    return r
  },
  action: (action: PkgAction, packages: string[] = []) => checked(api.call('er4', 'pkg_action', { action, packages })),
  job: async (lines = 200) => {
    const r = await api.call<SoftwareJob | Record<string, never>>('er4', 'pkg_job', { lines })
    return 'action' in r ? (r as SoftwareJob) : null
  },
}
