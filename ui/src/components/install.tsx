// An optional feature whose packages aren't installed: what it needs, an Install button, and the
// apk job's progress (er4.packages). The card around it polls its own status and takes over once
// the packages are there.
//   <InstallFeature feature="ipsec" what="strongSwan (IPsec/IKEv2)" />
import { useEffect, useState } from 'preact/hooks'
import { packages, type Feature, type Packages } from '../api/packages'
import { Badge, Button, ErrorBox } from './ui'

export function InstallFeature({ feature, what }: { feature: Feature; what: string }) {
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
  const failed = job && !job.running && job.rc !== null && !job.ok
  const start = () => packages.install(feature).then(() => packages.status().then(setSt), setErr)
  return (
    <div class="stack-3">
      {running ? (
        <div class="row"><Badge status="accent">installing</Badge><span class="secondary mono small">{job.log[job.log.length - 1] ?? 'starting…'}</span></div>
      ) : (
        <div class="row">
          <span class="secondary">{failed ? `Installing ${what} failed.` : `This needs ${what}, from the OpenWrt package repository.`}</span>
          <span style={{ flex: 1 }} />
          <Button variant="primary" disabled={!!st?.job?.running} title={st?.job?.running ? 'Another install is running' : undefined} onClick={start}>
            {failed ? 'Try again' : 'Install'}
          </Button>
        </div>
      )}
      {failed && <pre class="tool-out">{job.log.join('\n')}</pre>}
      {err != null && <ErrorBox error={err} />}
    </div>
  )
}
