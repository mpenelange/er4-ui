// The card the VPN page shows for a kind of VPN that isn't set up yet, the same for all three:
// what it does, which zones its devices may reach, one "Set up <name>" button, and one line on
// what that does. Options of its own (WireGuard's port, ...) go in as children. While the
// feature's packages install, the button's line shows apk's progress.
import type { ComponentChildren } from 'preact'
import type { Zone } from '../../api/firewall'
import { Badge, Button, Card, ErrorBox } from '../../components/ui'
import { MultiChips } from '../../components/chips'

/** The zones VPN devices may be allowed to reach: the inside ones, not WAN or another VPN's */
export const reachableZones = (zones: Zone[]) => zones.filter((z) => !z.masq && !VPN_ZONES.includes(z.name))
const VPN_ZONES = ['vpn', 'tailscale', 'ipsec']

export function VpnSetupCard({ title, name, intro, zones, reach, onReach, busy, disabled, onSetUp, installing, failedLog, error, note, children }: {
  /** card title, e.g. "IPsec / IKEv2" */
  title: string
  /** for the button: "Set up <name>" */
  name: string
  intro: ComponentChildren
  zones: Zone[]
  reach: string[]
  onReach: (z: string[]) => void
  busy: boolean
  disabled?: boolean
  onSetUp: () => void
  /** packages installing: apk's latest line (or '' before the first) */
  installing?: string
  /** a failed install's apk output */
  failedLog?: string[]
  error?: unknown
  note: ComponentChildren
  children?: ComponentChildren
}) {
  return (
    <Card title={title} actions={installing !== undefined ? <Badge status="accent">installing</Badge> : <Badge>not set up</Badge>}>
      <div class="stack-3">
        <p class="secondary vpn-intro">{intro}</p>
        {children}
        <div class="vpn-setup-row">
          <span class="muted small">VPN devices may reach</span>
          <MultiChips value={reach} onChange={onReach} label={`Zones ${name} devices may reach`} options={zones.map((z) => ({ value: z.name, label: z.name, slot: z.slot }))} />
          <span style={{ flex: 1 }} />
          <Button variant="primary" disabled={busy || disabled || installing !== undefined} onClick={onSetUp}>Set up {name}</Button>
        </div>
        {installing !== undefined && <span class="mono small secondary">{installing || 'starting…'}</span>}
        {failedLog && failedLog.length > 0 && <pre class="tool-out">{failedLog.join('\n')}</pre>}
        {error != null && <ErrorBox error={error} />}
        <span class="muted small">{note}</span>
      </div>
    </Card>
  )
}
