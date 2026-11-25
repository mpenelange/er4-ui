// System > Admin: HTTPS certificate (api/https.ts). Let's Encrypt by DNS-01 through Cloudflare, so
// nothing opens on the WAN; <host>.<domain> resolves to the router in its own DNS.
import { useState } from 'preact/hooks'
import { usePoll } from '../../api/store'
import { domainOk, emailOk, hostOk, https, tokenOk, type AcmeStatus } from '../../api/https'
import { Badge, Button, Card, ErrorBox, Field } from '../../components/ui'
import { Icon } from '../../components/icons'
import { InstallFeature } from '../../components/install'

export function HttpsCard() {
  const poll = usePoll(https.status, 4000)
  const st = poll.samples[0]
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true); setError(undefined)
    try { await f() } catch (e) { setError(e) } finally { setBusy(false) }
  }
  const cfg = st?.config
  return (
    <Card title={<span class="row">HTTPS certificate {st && <State st={st} />}</span>}>
      <div class="stack-3">
        {!st ? (poll.error ? <ErrorBox error={poll.error} /> : <span class="muted">Loading…</span>)
          : !st.installed ? <InstallFeature feature="acme" what="acme.sh with its DNS plugins" />
          : !cfg || editing ? (
            <Setup st={st} busy={busy} onCancel={cfg ? () => setEditing(false) : undefined}
              onSave={(s) => run(async () => { await https.setup(s); setEditing(false) })} />
          ) : (
            <Current st={st} busy={busy} onEdit={() => setEditing(true)}
              onRenew={() => run(https.renew)} onOff={() => run(https.off)} />
          )}
        {error ? <ErrorBox error={error} /> : null}
      </div>
    </Card>
  )
}

function State({ st }: { st: AcmeStatus }) {
  if (!st.config) return null
  if (st.running) return <Badge status="accent">getting certificate…</Badge>
  if (st.serving) return <Badge status="good">in use</Badge>
  if (st.cert) return <Badge status="warning">issued, not in use yet</Badge>
  return <Badge status="serious">no certificate</Badge>
}

function Setup({ st, busy, onSave, onCancel }: {
  st: AcmeStatus; busy: boolean; onSave: (s: { domain: string; host: string; email: string; token?: string }) => void; onCancel?: () => void
}) {
  const c = st.config
  const [domain, setDomain] = useState(c?.domain ?? '')
  const [host, setHost] = useState(c?.host ?? 'router')
  const [email, setEmail] = useState(c?.email ?? '')
  const [token, setToken] = useState('')
  const needToken = !c?.token_set
  const errs = {
    domain: domain && !domainOk(domain) ? 'A domain name like example.com' : undefined,
    host: host && !hostOk(host) ? 'Letters, digits and dashes' : undefined,
    email: email && !emailOk(email) ? 'An email address' : undefined,
    token: token && !tokenOk(token) ? "That doesn't look like an API token" : undefined,
  }
  const ok = domainOk(domain) && hostOk(host) && emailOk(email) && (token ? tokenOk(token) : !needToken)
  const submit = (e: Event) => { e.preventDefault(); if (ok) onSave({ domain, host, email, ...(token ? { token } : {}) }) }
  return (
    <form class="stack-3" onSubmit={submit}>
      <p class="secondary" style={{ margin: 0 }}>
        A Let's Encrypt certificate, so browsers trust this UI at a name in your domain. Let's Encrypt
        checks a DNS record the router adds through Cloudflare, so nothing opens on the internet. It
        renews by itself.
      </p>
      <div class="row" style={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <Field label="Router name" error={errs.host}>
          <input class={`input mono${errs.host ? ' invalid' : ''}`} style={{ width: 120 }} value={host} placeholder="router"
            onInput={(e) => setHost((e.target as HTMLInputElement).value.trim().toLowerCase())} />
        </Field>
        <Field label="Domain" error={errs.domain}>
          <input class={`input mono${errs.domain ? ' invalid' : ''}`} style={{ width: 220 }} value={domain} placeholder="example.com"
            onInput={(e) => setDomain((e.target as HTMLInputElement).value.trim().toLowerCase())} />
        </Field>
      </div>
      {domainOk(domain) && hostOk(host) && (
        <span class="secondary small">The UI will be at <b class="mono">https://{host}.{domain}</b>. The router's DNS answers that name with {st.lan ?? 'its LAN address'}; the certificate covers {domain} and *.{domain}.</span>
      )}
      <Field label="Email" hint="Your Let's Encrypt account" error={errs.email}>
        <input class={`input${errs.email ? ' invalid' : ''}`} type="email" value={email} placeholder="you@example.com"
          onInput={(e) => setEmail((e.target as HTMLInputElement).value.trim())} />
      </Field>
      <Field label="Cloudflare API token" error={errs.token}
        hint="Cloudflare: My Profile → API Tokens → Create Token → Custom token. Permissions: Zone · DNS · Edit and Zone · Zone · Read. Zone resources: only this domain.">
        <input class={`input mono${errs.token ? ' invalid' : ''}`} type={'password' as 'text'} autoComplete="off" value={token}
          placeholder={needToken ? '' : 'saved; leave empty to keep it'} onInput={(e) => setToken((e.target as HTMLInputElement).value.trim())} />
      </Field>
      <div class="row">
        <Button variant="primary" type="submit" icon="check" disabled={!ok || busy}>{busy ? 'Saving…' : 'Get certificate'}</Button>
        {onCancel && <Button variant="ghost" onClick={onCancel}>Cancel</Button>}
      </div>
    </form>
  )
}

// (no "Renew now": acme.sh skips a certificate that isn't due, so it would do nothing)
function Current({ st, busy, onEdit, onRenew, onOff }: { st: AcmeStatus; busy: boolean; onEdit: () => void; onRenew: () => void; onOff: () => void }) {
  const c = st.config!
  const url = `https://${c.host}.${c.domain}`
  const here = location.protocol === 'https:' && location.hostname === `${c.host}.${c.domain}`
  const failed = !st.running && !st.cert
  return (
    <>
      <div class="row" style={{ flexWrap: 'wrap' }}>
        {st.serving && !here ? <a class="mono" href={`${url}/`} target="_blank" rel="noopener"><b>{url}</b></a> : <b class="mono">{url}</b>}
        {here && <span class="muted small">you're on it</span>}
      </div>
      {st.cert && (
        <span class="secondary small">
          {st.cert.names.join(', ')} · {st.cert.issuer} · valid until {st.cert.not_after?.replace(/ \d\d:\d\d:\d\d/, '')}
          {st.cert.days != null && <> ({st.cert.days} days)</>}. Renews by itself.
        </span>
      )}
      {st.serving && !here && (
        <div class="note">
          <Icon name="info" /> <span>Use the address above from now on (log in again there). A device finds
          the name when it uses this router for DNS, the default on your network.</span>
        </div>
      )}
      {failed && <span class="secondary small">Getting the certificate failed; the log says why. Check the token's permissions and that the domain is on Cloudflare, then try again.</span>}
      <div class="row">
        {failed && <Button icon="refresh" disabled={busy} onClick={onRenew}>Try again</Button>}
        <Button variant="ghost" disabled={busy} onClick={onEdit}>Change…</Button>
        <span style={{ flex: 1 }} />
        <Button variant="ghost" icon="power" disabled={busy} title="Back to the self-signed certificate; removes the token, the certificate and the DNS name" onClick={onOff}>Turn off</Button>
      </div>
      {!!st.log?.length && (
        <details class="disclosure" open={st.running || failed}>
          <summary>Log</summary>
          <pre class="acme-log mono">{st.log.join('\n')}</pre>
        </details>
      )}
    </>
  )
}
