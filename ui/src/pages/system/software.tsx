// System > Software: apk. The installed packages (and their updates), a search of the package
// repositories, a package's details (what it needs, what needs it), install / remove / upgrade, and
// installing an uploaded .apk (unsigned, e.g. one built here). One apk job runs at a time on the
// router; the job card follows it and shows its log.
import { useEffect, useMemo, useState } from 'preact/hooks'
import { useAsync } from '../../api/store'
import { PKG_UPLOAD, software, type PkgAction, type PkgFound, type PkgInfo, type PkgInstalled, type SoftwareJob } from '../../api/packages'
import { upload } from '../../api/system'
import { bytes } from '../../components/format'
import { Badge, Button, Card, Drawer, Empty, ErrorBox, Modal, Segmented, Table, type Column } from '../../components/ui'
import { agoRouter, Dropzone } from './common'

/** What this router or this UI can't do without: removing them gets a stronger warning. */
const VITAL = new Set(['base-files', 'busybox', 'procd', 'ubus', 'ubox', 'netifd', 'firewall4', 'dnsmasq', 'dropbear', 'uhttpd', 'uhttpd-mod-ubus',
  'rpcd', 'rpcd-mod-ucode', 'rpcd-mod-luci', 'cgi-io', 'ucode', 'ucode-mod-fs', 'ucode-mod-uci', 'apk-mbedtls', 'apk-openssl', 'libc', 'kernel',
  'er4-ui', 'kmod-octeon-offload', 'nftables-json', 'kmod-nft-offload', 'odhcpd-ipv6only', 'odhcp6c', 'urandom-seed', 'fstools', 'mtd', 'opkg'])

const LABEL: Record<SoftwareJob['action'], string> = {
  add: 'Installing', del: 'Removing', upgrade: 'Upgrading', 'upgrade-all': 'Upgrading all packages', update: 'Refreshing the package lists',
  'add-file': 'Installing the uploaded package', install: 'Installing',
}

/** The package job: polled while it runs; `onDone` once it has finished. */
function useJob(onDone: () => void) {
  const [job, setJob] = useState<SoftwareJob | null>()
  const [kick, setKick] = useState(0)
  useEffect(() => {
    let alive = true
    let timer: number | undefined
    let wasRunning = false
    const tick = () => software.job().then((j) => {
      if (!alive) return
      setJob(j)
      if (wasRunning && !j?.running) onDone()
      wasRunning = !!j?.running
      if (j?.running) timer = window.setTimeout(tick, 1500)
    }, () => { if (alive) timer = window.setTimeout(tick, 3000) })
    tick()
    return () => { alive = false; clearTimeout(timer) }
  }, [kick])
  return { job, started: () => setKick((k) => k + 1) }
}

export function Software() {
  const list = useAsync(software.list, [], [])
  const { job, started } = useJob(() => list.reload())
  const [view, setView] = useState<'installed' | 'updates' | 'search'>('installed')
  const [filter, setFilter] = useState('')
  const [q, setQ] = useState('')
  const [found, setFound] = useState<{ q: string; packages: PkgFound[]; more: boolean }>()
  const [searchErr, setSearchErr] = useState<unknown>()
  const [detail, setDetail] = useState<string>()
  const [confirm, setConfirm] = useState<{ action: PkgAction; packages: string[]; title: string; body: preact.ComponentChildren }>()
  const [uploading, setUploading] = useState<{ name: string; p: number } | false>(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [err, setErr] = useState<unknown>()
  const busy = !!job?.running

  // search the repositories (on the router, debounced)
  useEffect(() => {
    if (view !== 'search') return
    const s = q.trim()
    if (s.length < 2) { setFound(undefined); return }
    const t = setTimeout(() => software.search(s).then((r) => { setFound({ q: s, ...r }); setSearchErr(undefined) }, setSearchErr), 350)
    return () => clearTimeout(t)
  }, [q, view])

  const run = async (action: PkgAction, packages: string[] = []) => {
    setErr(undefined)
    try { await software.action(action, packages); started() } catch (e) { setErr(e) }
  }
  const installed = list.data?.packages ?? []
  const updates = installed.filter((p) => p.upgrade)
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase()
    return (view === 'updates' ? updates : installed).filter((p) => !f || p.name.toLowerCase().includes(f) || (p.description ?? '').toLowerCase().includes(f))
  }, [list.data, view, filter])

  const remove = (name: string, requiredBy: string[] = []) => setConfirm({
    action: 'del', packages: [name], title: `Remove ${name}?`,
    body: <>
      {VITAL.has(name) && <p class="warn-line">The router or this UI needs {name}. Removing it can break the network or lock you out of this page.</p>}
      {requiredBy.length > 0 && <p class="warn-line">Needed by {requiredBy.join(', ')}: apk keeps it while they're installed.</p>}
      <p style={{ margin: 0 }}>apk removes it, and the packages it pulled in that nothing else needs.</p>
    </>,
  })

  const instCols: Column<PkgInstalled>[] = [
    { key: 'name', label: 'Package', render: (p) => <span class="row">{p.world ? <b>{p.name}</b> : <span>{p.name}</span>}{!p.world && <span class="muted small">dependency</span>}</span> },
    { key: 'version', label: 'Version', render: (p) => <span class="mono">{p.version}{p.upgrade && <> <Badge status="warning">{p.upgrade}</Badge></>}</span> },
    { key: 'size', label: 'Size', num: true, value: (p) => p.size, render: (p) => bytes(p.size) },
    { key: 'description', label: 'Description', render: (p) => <span class="muted ellipsis" title={p.description}>{p.description}</span> },
  ]
  const foundCols: Column<PkgFound>[] = [
    { key: 'name', label: 'Package', render: (p) => <b>{p.name}</b> },
    { key: 'version', label: 'Version', render: (p) => <span class="mono">{p.version}</span> },
    { key: 'size', label: 'Download', num: true, value: (p) => p.size, render: (p) => bytes(p.size) },
    { key: 'description', label: 'Description', render: (p) => <span class="muted ellipsis" title={p.description}>{p.description}</span> },
    { key: 'action', label: '', render: (p) => p.installed
      ? <Badge status="good">installed</Badge>
      : <Button disabled={busy} onClick={(e) => { e.stopPropagation(); run('add', [p.name]) }}>Install</Button> },
  ]

  return (
    <div class="stack-3">
      {job && <JobCard job={job} />}
      {err != null && <ErrorBox error={err} />}
      <Card flush title={<span class="row">Software {list.data && <span class="muted small">lists refreshed {agoRouter(list.data.updated) || 'never'}</span>}</span>} actions={<>
        <Segmented value={view} onChange={setView} options={[
          { value: 'installed', label: `Installed${installed.length ? ` (${installed.length})` : ''}` },
          { value: 'updates', label: `Updates${updates.length ? ` (${updates.length})` : ''}` },
          { value: 'search', label: 'Find packages' },
        ]} />
        {view === 'search'
          ? <input class="input" type="search" placeholder="Name or description" aria-label="Search packages" value={q} autoFocus onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
          : <input class="input" type="search" placeholder="Filter" aria-label="Filter installed packages" value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />}
        <Button icon="refresh" disabled={busy} title="apk update: fetch the current package lists" onClick={() => run('update')}>Refresh lists</Button>
        {view === 'updates' && updates.length > 0 && <Button variant="primary" disabled={busy} onClick={() => setConfirm({
          action: 'upgrade-all', packages: [], title: `Upgrade ${updates.length} package${updates.length === 1 ? '' : 's'}?`,
          body: <p style={{ margin: 0 }}>apk upgrade installs the newer versions from the repositories. Services restart as their packages change; a sysupgrade later doesn't keep these upgrades.</p>,
        })}>Upgrade all</Button>}
        <Button icon="upload" disabled={busy} onClick={() => setUploadOpen(true)}>Upload .apk</Button>
      </>}>
        {list.error ? <div class="card-body"><ErrorBox error={list.error} /></div>
          : !list.data ? <div class="card-body muted">Loading…</div>
          : view !== 'search' ? (
            <Table columns={instCols} rows={shown} rowKey={(p) => p.name} onRowClick={(p) => setDetail(p.name)}
              empty={view === 'updates' ? 'Everything is up to date (as of the last list refresh).' : 'No package matches.'} />
          ) : searchErr ? <div class="card-body"><ErrorBox error={searchErr} /></div>
          : !found ? <div class="card-body"><Empty>Type at least two characters to search the OpenWrt package repositories.</Empty></div>
          : (
            <>
              <Table columns={foundCols} rows={found.packages} rowKey={(p) => p.name} onRowClick={(p) => setDetail(p.name)} empty={`Nothing matches “${found.q}”.`} />
              {found.more && <div class="card-body muted small">Showing the first 200 matches: refine the search.</div>}
            </>
          )}
      </Card>

      {detail && <Details name={detail} busy={busy} onClose={() => setDetail(undefined)}
        onAction={(a, n) => { setDetail(undefined); run(a, [n]) }}
        onRemove={(n, req) => { setDetail(undefined); remove(n, req) }} />}

      {confirm && (
        <Modal title={confirm.title} onClose={() => setConfirm(undefined)} footer={<>
          <Button variant="ghost" onClick={() => setConfirm(undefined)}>Cancel</Button>
          <Button variant={confirm.action === 'del' ? 'danger' : 'primary'} onClick={() => { const c = confirm; setConfirm(undefined); run(c.action, c.packages) }}>
            {confirm.action === 'del' ? 'Remove' : 'Upgrade'}
          </Button>
        </>}>{confirm.body}</Modal>
      )}

      {uploadOpen && (
        <Modal title="Install an .apk file" onClose={() => { if (!uploading) setUploadOpen(false) }}>
          <div class="stack-3">
            {uploading ? <div class="row"><Badge status="accent">uploading</Badge><span class="muted">{uploading.name} · {Math.round(uploading.p * 100)}%</span></div>
              : <Dropzone accept=".apk" title="Drop an .apk, or click to choose" hint="e.g. kmod-octeon-offload-….apk" disabled={busy} onFile={async (f) => {
                setUploading({ name: f.name, p: 0 })
                try {
                  await upload(f, PKG_UPLOAD, (p) => setUploading({ name: f.name, p }))
                  setUploadOpen(false)
                  await run('add-file')
                } catch (e) { setErr(e) } finally { setUploading(false) }
              }} />}
            <span class="muted small">Installed with apk add --allow-untrusted: the package isn't signature-checked, so only use files you trust.</span>
          </div>
        </Modal>
      )}
    </div>
  )
}

function JobCard({ job }: { job: SoftwareJob }) {
  const what = job.packages.length && job.action !== 'install' ? `${LABEL[job.action]} ${job.packages.join(', ')}` : job.feature ? `${LABEL[job.action]} ${job.feature}` : LABEL[job.action]
  const state = job.running ? <Badge status="accent">running</Badge> : job.ok ? <Badge status="good">done</Badge> : <Badge status="critical">failed</Badge>
  return (
    <Card title={<span class="row">{what} {state}</span>}>
      <div class="stack">
        <span class="mono small secondary">{job.log[job.log.length - 1] ?? (job.running ? 'starting…' : '')}</span>
        {job.log.length > 1 && (
          <details open={!job.running && !job.ok}>
            <summary class="muted small">apk output</summary>
            <pre class="tool-out">{job.log.join('\n')}</pre>
          </details>
        )}
      </div>
    </Card>
  )
}

function Details({ name, busy, onClose, onAction, onRemove }: {
  name: string; busy: boolean; onClose: () => void
  onAction: (a: 'add' | 'upgrade', n: string) => void; onRemove: (n: string, requiredBy: string[]) => void
}) {
  const info = useAsync(() => software.info(name), [name], [])
  const p: PkgInfo | undefined = info.data
  const newer = p && p.installed && p.installed !== p.version
  return (
    <Drawer title={name} onClose={onClose} footer={p && <>
      {!p.installed && <Button variant="primary" disabled={busy} onClick={() => onAction('add', name)}>Install</Button>}
      {newer && <Button variant="primary" disabled={busy} onClick={() => onAction('upgrade', name)}>Upgrade to {p.version}</Button>}
      {p.installed && <Button variant="danger" disabled={busy} onClick={() => onRemove(name, p.required_by)}>Remove</Button>}
    </>}>
      {info.error ? <ErrorBox error={info.error} /> : !p ? <span class="muted">Loading…</span> : (
        <div class="stack-3">
          <p style={{ margin: 0 }}>{p.description}</p>
          <dl class="kv">
            <dt>Version</dt><dd class="mono">{p.installed ? (newer ? <>{p.installed} installed, {p.version} available</> : <>{p.installed} installed</>) : p.version}</dd>
            {p.installed && <><dt>Installed</dt><dd>{p.world ? 'asked for' : 'as a dependency'}</dd></>}
            <dt>Size</dt><dd>{bytes(p.size)} installed{p.download ? `, ${bytes(p.download)} download` : ''}</dd>
            {p.license && <><dt>Licence</dt><dd>{p.license}</dd></>}
            {p.url && <><dt>Website</dt><dd><a href={p.url} target="_blank" rel="noopener noreferrer">{p.url}</a></dd></>}
            <dt>Needs</dt><dd>{p.depends.length ? p.depends.join(', ') : 'nothing'}</dd>
            {p.installed && <><dt>Needed by</dt><dd>{p.required_by.length ? p.required_by.join(', ') : 'nothing installed'}</dd></>}
          </dl>
          {VITAL.has(name) && p.installed && <span class="warn-line">The router or this UI needs this package.</span>}
        </div>
      )}
    </Drawer>
  )
}
