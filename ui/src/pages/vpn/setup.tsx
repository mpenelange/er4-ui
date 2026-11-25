// WireGuard's set-up card (no WireGuard interface yet; also the "New tunnel" drawer). Stages, in one go:
//   network:  interface wg0 (proto wireguard, private key, listen port, tunnel address)
//   firewall: zone 'vpn' (or wg0 added to an existing one), forwardings vpn -> chosen zones
//             (+ vpn -> wan for full-tunnel devices), rule "Allow-WireGuard" on wan UDP port
import { useEffect, useState } from 'preact/hooks'
import { useInstall } from '../../components/install'
import { uci } from '../../api/uci'
import { forwardings, zones as zonesOf } from '../../api/firewall'
import { cidr, cidrStr, interfaceSubnets } from '../../api/ip4'
import { freeTunnelSubnet, freeWgName, wg, wgInterfaces } from '../../api/wireguard'
import { Field, Toggle } from '../../components/ui'
import { VpnSetupCard, reachableZones } from './setup-card'
import type { VpnData } from './shared'

export function Setup({ data, onDone }: { data: VpnData; onDone?: (iface: string) => void }) {
  const zones = zonesOf(data.fw)
  const inside = reachableZones(zones)
  const wan = zones.find((z) => z.masq) ?? zones.find((z) => z.name === 'wan')
  const subnets = interfaceSubnets(data.net)
  // a second road-warrior tunnel needs its own port
  const usedPorts = wgInterfaces(data.net).map((s) => String(s.listen_port ?? ''))
  const [port, setPort] = useState(() => { let p = 51820; while (usedPorts.includes(String(p))) p++; return String(p) })
  const [address, setAddress] = useState(() => freeTunnelSubnet(Object.values(subnets)))
  const [reach, setReach] = useState<string[]>(inside.some((z) => z.name === 'lan') ? ['lan'] : inside.slice(0, 1).map((z) => z.name))
  const [internet, setInternet] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()
  // "Set up WireGuard" before wireguard-tools was there: set up once it's installed
  const [pending, setPending] = useState(false)
  const pkg = useInstall('wireguard')

  const portOk = /^\d{1,5}$/.test(port) && +port > 0 && +port < 65536
  const c = cidr(address)
  const addrOk = !!c && c.prefix <= 30 && c.addr !== c.network
  const clash = c && Object.entries(subnets).find(([, s]) => cidrStr(s) === cidrStr(c))
  const name = freeWgName(data.net)
  const portClash = usedPorts.includes(port)

  useEffect(() => {
    if (pending && pkg.installed) { setPending(false); create() }
  }, [pending, pkg.installed])
  const setUp = () => {
    if (pkg.installed !== false) return create()
    setPending(true)
    pkg.start().catch(() => setPending(false))
  }

  const create = async () => {
    setBusy(true)
    try {
      const keys = await wg.keyPair()
      // firewall first: staging the interface switches this page to the device list, so an
      // error after that would have nowhere to show
      const existing = zones.find((z) => z.name === 'vpn')
      if (existing) await uci.set('firewall', existing.section, { network: [...existing.networks, name] })
      else await uci.add('firewall', 'zone', { name: 'vpn', network: [name], input: 'ACCEPT', output: 'ACCEPT', forward: 'REJECT' })
      const have = forwardings(data.fw).filter((f) => f.src === 'vpn').map((f) => f.dest)
      for (const z of [...reach, ...(internet && wan ? [wan.name] : [])]) if (!have.includes(z)) await uci.add('firewall', 'forwarding', { src: 'vpn', dest: z })
      if (wan) await uci.add('firewall', 'rule', { name: name === 'wg0' ? 'Allow-WireGuard' : `Allow-WireGuard-${name}`, src: wan.name, proto: 'udp', dest_port: port, target: 'ACCEPT' })
      await uci.add('network', 'interface', { proto: 'wireguard', private_key: keys.priv, listen_port: port, addresses: [address] }, name)
      onDone?.(name)
    } catch (e) {
      setError(e)
      setBusy(false)
    }
  }

  return (
    <VpnSetupCard title="WireGuard" name="WireGuard"
      intro="Phones and laptops connect to this router over an encrypted tunnel (the WireGuard app), then use your home network, and your home internet if you like, as if they were here."
      zones={inside} reach={reach} onReach={setReach} busy={busy} disabled={!portOk || portClash || !addrOk || !!clash} onSetUp={setUp}
      installing={pkg.running || (pending && !pkg.installed) ? pkg.last ?? '' : undefined} failedLog={pkg.failed ? pkg.log : undefined} error={error ?? pkg.error}
      note={<>{pkg.installed === false && <>Installs wireguard-tools from the OpenWrt package repository first. </>}Stages interface {name}, firewall zone <b>vpn</b> and a rule allowing UDP {port} from {wan?.name ?? 'wan'}. Nothing changes until you apply.</>}>
      <details class="vpn-setup-options" open={!portOk || portClash || !addrOk || !!clash}>
        <summary><span class="muted small">Options</span> <span class="mono small">UDP {port} · {address} · {internet ? 'full tunnel' : 'home network only'}</span></summary>
      <div class="vpn-setup-grid">
        <Field label="Port (UDP)" hint="Opened on the internet side" error={!portOk ? '1-65535' : portClash ? 'Another tunnel listens there' : undefined}>
          <input class={`input mono${portOk && !portClash ? '' : ' invalid'}`} value={port} onInput={(e) => setPort((e.target as HTMLInputElement).value.trim())} />
        </Field>
        <Field label="Tunnel network" hint={clash ? `Overlaps ${clash[0]}` : 'Router address / size; devices get the next free addresses'} error={addrOk && !clash ? undefined : clash ? `Same subnet as ${clash[0]}` : 'e.g. 10.200.0.1/24'}>
          <input class={`input mono${addrOk && !clash ? '' : ' invalid'}`} value={address} onInput={(e) => setAddress((e.target as HTMLInputElement).value.trim())} />
        </Field>
        <label class="row vpn-setup-toggle">
          <Toggle on={internet} label="Allow internet through home" onChange={setInternet} /> VPN devices may use this internet connection (full tunnel)
        </label>
      </div>
      </details>
    </VpnSetupCard>
  )
}
