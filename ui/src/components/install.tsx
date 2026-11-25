// Optional features whose packages aren't installed yet (er4.packages / er4.pkg_install):
//   useInstall(feature)  -> {installed, running, failed, last, log, start}: polls the package job
//                           while it runs; the caller's own status poll takes over afterwards
//   <InstallFeature feature="acme" what="acme.sh" />  a ready-made "needs X" line + Install button
import { useEffect, useState } from 'preact/hooks'
import { packages, type Feature, type Packages } from '../api/packages'
import { Badge, Button, ErrorBox } from './ui'

export function useInstall(feature: Feature) {
  const [st, setSt] = useState<Packages>()
  const [err, setErr] = useState<unknown>()
  const job = st?.job?.feature === feature ? st.job : null
  const running = !!job?.running
  useEffect(() => {
    let alive = true
    let timer: number | undefined
    const tick = () => packages.status().then((s) => { if (alive) setSt(s) }, () => {}).finally(() => {
      if (alive) timer = window.setTimeout(tick, running ? 1500 : 5000)
    })
    tick()
    return () => { alive = false; clearTimeout(timer) }
  }, [running])
  const failed = !!job && !job.running && job.rc !== null && !job.ok
  return {
    installed: st?.[feature],
    running,
    failed,
    /** another feature's install is running (one apk job at a time) */
    blocked: !!st?.job?.running && !running,
    last: job?.log[job.log.length - 1],
    log: job?.log ?? [],
    error: err,
    start: () => { setErr(undefined); return packages.install(feature).then(() => packages.status().then(setSt), (e) => { setErr(e); throw e }) },
  }
}

export function InstallFeature({ feature, what }: { feature: Feature; what: string }) {
  const i = useInstall(feature)
  return (
    <div class="stack-3">
      {i.running ? (
        <div class="row"><Badge status="accent">installing</Badge><span class="secondary mono small">{i.last ?? 'starting…'}</span></div>
      ) : (
        <div class="row">
          <span class="secondary">{i.failed ? `Installing ${what} failed.` : `This needs ${what}, from the OpenWrt package repository.`}</span>
          <span style={{ flex: 1 }} />
          <Button variant="primary" disabled={i.blocked} title={i.blocked ? 'Another install is running' : undefined} onClick={() => i.start().catch(() => {})}>
            {i.failed ? 'Try again' : 'Install'}
          </Button>
        </div>
      )}
      {i.failed && <pre class="tool-out">{i.log.join('\n')}</pre>}
      {i.error != null && <ErrorBox error={i.error} />}
    </div>
  )
}
