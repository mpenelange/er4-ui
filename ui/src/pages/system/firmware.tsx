// System > Firmware: OpenWrt's sysupgrade. Upload a sysupgrade image, the router checks it
// (sysupgrade -T, built for this board, and whether it has the Octeon offload driver hooks), then
// sysupgrade installs it and reboots, keeping the settings or starting from defaults.
import { useState } from 'preact/hooks'
import { useAsync } from '../../api/store'
import { FIRMWARE_PATH, system, upload, type FirmwareVerify } from '../../api/system'
import { bytes } from '../../components/format'
import { KV, Meter } from '../../components/readouts'
import { Badge, Button, Card, ErrorBox, Modal, Toggle } from '../../components/ui'
import { Dropzone, RebootWait } from './common'

type Step =
  | { k: 'choose' }
  | { k: 'uploading'; name: string; p: number }
  | { k: 'verifying'; name: string }
  | { k: 'verified'; name: string; v: FirmwareVerify }
  | { k: 'error'; message: string }

export function Firmware() {
  const info = useAsync(system.firmwareInfo, [], [])
  const [step, setStep] = useState<Step>({ k: 'choose' })
  const [keep, setKeep] = useState(true)
  const [confirm, setConfirm] = useState(false)
  const [installing, setInstalling] = useState(false)
  const d = info.data

  async function onFile(f: File) {
    setStep({ k: 'uploading', name: f.name, p: 0 })
    try {
      await upload(f, FIRMWARE_PATH, (p) => setStep({ k: 'uploading', name: f.name, p }))
      setStep({ k: 'verifying', name: f.name })
      setStep({ k: 'verified', name: f.name, v: await system.firmwareVerify(FIRMWARE_PATH) })
    } catch (e) {
      setStep({ k: 'error', message: (e as Error).message })
    }
  }

  if (installing) return <RebootWait reason="Installing the new firmware" expect={240} />
  const noHooks = step.k === 'verified' && step.v.checks.some((c) => c.id === 'offload' && c.ok === false)
  return (
    <div class="stack-3">
      <Card title="Running">
        {info.error ? <ErrorBox error={info.error} /> : !d ? <span class="muted">Loading…</span> : (
          <KV rows={[
            ['Device', <>{d.model} <span class="muted mono">{d.board}</span></>],
            ['Firmware', d.release.description ?? `${d.release.id} ${d.release.release}`],
            ['Kernel', <span class="mono">{d.kernel}</span>],
            ['Hardware offload', d.hooks ? <Badge status="good">driver hooks present</Badge> : <Badge>not in this kernel</Badge>],
          ]} />
        )}
      </Card>

      <Card title="Install an image">
        <div class="stack-3">
          {(step.k === 'choose' || step.k === 'error') && (
            <Dropzone accept=".tar,.bin" onFile={onFile} title="Drop a sysupgrade image, or click to choose" hint="openwrt-…-squashfs-sysupgrade.tar" />
          )}
          {step.k === 'error' && <ErrorBox error={step.message} />}
          {step.k === 'uploading' && <Progress label={`Uploading ${step.name}`} p={step.p} />}
          {step.k === 'verifying' && <Progress label={`Checking ${step.name}`} p={NaN} />}
          {step.k === 'verified' && (
            <div class="stack-3">
              <ul class="checks">
                {step.v.checks.map((c) => (
                  <li class={c.ok === false && c.id !== 'offload' ? 'bad' : ''}>
                    {c.ok === true ? <Badge status="good">ok</Badge> : c.ok === false ? <Badge status={c.id === 'offload' ? 'warning' : 'critical'}>{c.id === 'offload' ? 'no' : 'fail'}</Badge> : <Badge>info</Badge>}
                    <span class="check-label">{c.label}</span>
                    <span class={`muted${c.id === 'sha256' ? ' mono hash' : ''}`}>{c.detail}</span>
                  </li>
                ))}
              </ul>
              {step.v.valid ? (
                <>
                  {noHooks && (
                    <div class="warn-line">This image's kernel doesn't have the Octeon offload driver hooks (an official OpenWrt build?). It runs fine, but nothing will be offloaded in hardware.</div>
                  )}
                  <label class="row"><Toggle on={keep} label="Keep settings" onChange={setKeep} /> Keep the current settings</label>
                  {!keep && <div class="warn-line">The router starts from OpenWrt's defaults: LAN 192.168.1.1, no password. Installed packages are gone too.</div>}
                  <div class="row">
                    <span class="muted">{step.name}{step.v.image && ` · ${bytes(step.v.image.size)}`}</span>
                    <span class="spacer" />
                    <Button variant="ghost" onClick={() => setStep({ k: 'choose' })}>Choose another</Button>
                    <Button variant="primary" icon="power" onClick={() => setConfirm(true)}>Install…</Button>
                  </div>
                </>
              ) : (
                <div class="row">
                  <span class="secondary">This image can't be installed on this router. Nothing was written.</span>
                  <span class="spacer" />
                  <Button onClick={() => setStep({ k: 'choose' })}>Choose another</Button>
                </div>
              )}
            </div>
          )}
          <span class="muted small">Packages installed since the last image (with apk) are not carried over by sysupgrade. Take a backup first (Backup &amp; reboot).</span>
        </div>
      </Card>

      {confirm && (
        <Modal title="Install the new firmware?" onClose={() => setConfirm(false)} footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button>
            <Button variant="primary" icon="power" onClick={async () => {
              setConfirm(false)
              // the wait screen first: the router goes down before long
              setInstalling(true)
              try { await system.firmwareInstall(FIRMWARE_PATH, keep) } catch (e) {
                setInstalling(false)
                setStep({ k: 'error', message: (e as Error).message })
              }
            }}>Install and reboot</Button>
          </>
        }>
          <p style={{ margin: 0 }}>
            The router writes the image and reboots: a few minutes offline. {keep ? 'Settings are kept.' : 'Settings are reset to defaults.'} Don't power it off meanwhile.
          </p>
        </Modal>
      )}
    </div>
  )
}

function Progress({ label, p }: { label: string; p: number }) {
  return (
    <div class="stack">
      <div class="row"><span>{label}</span><span class="spacer" /><span class="num muted">{isFinite(p) ? `${Math.round(p * 100)}%` : ''}</span></div>
      {isFinite(p) ? <Meter value={p} label={label} /> : <div class="indeterminate"><div /></div>}
    </div>
  )
}
