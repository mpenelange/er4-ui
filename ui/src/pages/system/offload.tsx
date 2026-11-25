// System > Hardware offload: fw4's flow offloading switches (firewall defaults, staged) next to
// kmod-octeon-offload's live state (er4.offload) and the fast path's share of forwarded packets.
import { router } from '../../api/router'
import { useAsync, usePoll } from '../../api/store'
import type { Er4Offload } from '../../api/types'
import { uci } from '../../api/uci'
import { count, pct, pps } from '../../components/format'
import { KV, SplitBar } from '../../components/readouts'
import { Trend } from '../../components/trend'
import { Badge, Card, ErrorBox, Toggle } from '../../components/ui'
import { useLive } from '../dashboard/live'
import { Unapplied, useStaged } from './common'

type Opt = 'flow_offloading' | 'flow_offloading_hw'

const OPTIONS: { key: Opt; label: string; hint: string; live: (o: Er4Offload) => boolean }[] = [
  { key: 'flow_offloading', label: 'Software flow offloading', hint: 'OpenWrt\'s flowtable: once fw4 has accepted a connection, its packets skip most of the Linux network stack. Needed for the hardware fast path.', live: (o) => o.software },
  { key: 'flow_offloading_hw', label: 'Hardware flow offloading', hint: 'Hands the flowtable\'s flows to kmod-octeon-offload, which forwards them in the ethernet driver: TCP and UDP between the router\'s ports, IPv4 NAT, one VLAN tag. Everything else stays in the software flowtable.', live: (o) => o.hardware },
]

export function Offload() {
  const cfg = useAsync(() => uci.sections('firewall', 'defaults').then((l) => l[0]))
  const state = usePoll(router.offload, 3000)
  const staged = useStaged('firewall')
  const live = useLive()
  const o = state.samples[0]
  const g = cfg.data
  const name = g?.['.name'] as string | undefined
  const software = g?.flow_offloading === '1'

  return (
    <div class="sys-cols wide-left">
      <Card title="Offload settings" actions={<span class="muted">/etc/config/firewall · defaults</span>} flush>
        {cfg.error ? <div class="card-body"><ErrorBox error={cfg.error} /></div> : !g || !name ? <div class="card-body muted">Loading…</div> : (
          <table class="table offload-table">
            <thead>
              <tr><th style={{ width: 44 }} /><th>Setting</th><th style={{ width: 120 }}>Running now</th></tr>
            </thead>
            <tbody>
              {OPTIONS.map((opt) => {
                const on = g[opt.key] === '1'
                const dim = opt.key === 'flow_offloading_hw' && !software
                const liveOn = o ? opt.live(o) : undefined
                const pending = staged.has(name, opt.key)
                return (
                  <tr class={dim ? 'disabled' : ''}>
                    <td><Toggle on={on} label={opt.label} disabled={dim} onChange={(v) => uci.set('firewall', name, { [opt.key]: v ? '1' : '0' })} /></td>
                    <td class="wrap">
                      <div class="setting-label">
                        {opt.label}
                        <code class="muted">{opt.key}</code>
                        <Unapplied show={pending} />
                      </div>
                      <div class="setting-hint">{opt.hint}</div>
                    </td>
                    <td>
                      {liveOn === undefined ? <span class="muted">…</span>
                        : liveOn ? <Badge status="good">on</Badge> : <Badge>off</Badge>}
                      {pending && <div class="muted small">changes on apply</div>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Card>
      <div class="stack-3">
        <LiveCard o={o} error={state.error} live={live} />
        <Card title="How it works">
          <ol class="plain-list numbered secondary">
            <li>The first packets of a connection go through the Linux stack: firewall (fw4), NAT, routing.</li>
            <li>Once fw4 has accepted it, the connection is added to OpenWrt's flowtable, and the flowtable hands it to the hardware fast path, which forwards its packets in the ethernet driver.</li>
            <li>Firewall rules see only those first packets: a rate limit or log rule doesn't see the rest of an offloaded connection.</li>
            <li>Traffic between ports in the same bridge is switched by the CPU, never offloaded: the ER-4 has no switch chip.</li>
          </ol>
        </Card>
      </div>
    </div>
  )
}

function LiveCard({ o, error, live }: { o?: Er4Offload; error?: Error; live: ReturnType<typeof useLive> }) {
  const s = live.samples
  const a = s[s.length - 2], b = s[s.length - 1]
  const dt = a && b ? (b.time - a.time) / 1000 : 1
  const fast = a && b ? (b.offload.flow_found - a.offload.flow_found) / dt : NaN
  const slow = a && b ? (b.offload.flow_not_found - a.offload.flow_not_found) / dt : NaN
  const idle = !(fast + slow > 0)
  const active = !!o && o.loaded && o.hooks && o.hardware
  const wanted = o?.ports_wanted ?? []
  const refused = o ? Object.entries(o.counters).filter(([k, v]) => k.startsWith('refused_') && typeof v === 'number' && v > 0) : []
  const n = (k: string) => (typeof o?.counters[k] === 'number' ? (o.counters[k] as number) : 0)
  const badge = !o ? null
    : !o.loaded ? <Badge status="warning">module not loaded</Badge>
    : !o.hooks ? <Badge status="warning">no driver hooks</Badge>
    : !o.hardware ? <Badge>off</Badge>
    : o.ports < wanted.length ? <Badge status="warning">{o.ports} of {wanted.length} ports</Badge>
    : <Badge status="good">active</Badge>
  return (
    <Card title="Live" actions={badge}>
      {error && !o ? <ErrorBox error={error} /> : !o ? <div class="muted">Loading…</div> : (
        <div class="stack-3">
          {!o.loaded ? (
            <p class="secondary" style={{ margin: 0 }}>kmod-octeon-offload isn't loaded: all forwarding uses the CPU.</p>
          ) : !o.hooks ? (
            <p class="secondary" style={{ margin: 0 }}>The module is loaded, but this kernel doesn't have the Octeon driver hooks (OpenWrt octeon patch 703), so nothing is offloaded in hardware.</p>
          ) : active && !live.error ? (
            <>
              <div class="offload-share-sm">
                <span class="value">{idle ? '–' : pct((100 * fast) / (fast + slow), 1)}</span>
                <span class="secondary">of the packets it sees on the fast path</span>
              </div>
              <SplitBar parts={[
                { value: idle ? 0 : fast, label: <>Fast path <b class="num">{pps(idle ? 0 : fast)}</b></> },
                { value: idle ? 0 : slow, neutral: true, label: <>Linux stack <b class="num">{pps(idle ? 0 : slow)}</b></> },
              ]} />
              <div class="row" style={{ justifyContent: 'space-between' }}>
                <span class="muted small">fast path · 5 min</span>
                <div style={{ width: '160px' }}><Trend values={live.rates.map((r) => (r ? r.offloadPps : null))} color="--accent" height={22} fill /></div>
              </div>
            </>
          ) : live.error ? <ErrorBox error={live.error} /> : (
            <p class="secondary" style={{ margin: 0 }}>Hardware flow offloading is off: turn it on and apply.</p>
          )}
          <KV rows={[
            o.loaded && ['Ports', <span title="Bound to fw4's flowtable, of the ports fw4 put in it">
              <span class="num">{o.ports}</span> of <span class="num">{wanted.length}</span>{wanted.length > 0 && <span class="muted"> ({wanted.join(', ')})</span>}</span>],
            o.loaded && ['Flows', <span class="num">{count(o.flows)} / {count(o.max_flows)}</span>],
            o.loaded && ['Forwarded', <span class="num">{count(n('forwarded'))} packets since load</span>],
            o.loaded && n('tx_errors') > 0 && ['Send errors', <span class="num">{count(n('tx_errors'))}</span>],
            o.loaded && refused.length > 0 && ['Left to software', <span>{refused.map(([k, v]) => `${k.slice(8).replace('_', ' ')} ${count(v as number)}`).join(' · ')}</span>],
            b && ['Conntrack', <span class="num">{count(b.conntrack.count)} / {count(b.conntrack.max)}</span>],
          ]} />
        </div>
      )}
    </Card>
  )
}
