// rpcd plugin "er4": live router state for the er4 web UI on stock OpenWrt (served at /er4/,
// next to LuCI). Reply shapes are the contract in ui/src/api/types.ts and ui/src/api/mock/ext/*.ts.
// Offload state comes from kmod-octeon-offload (/proc/octeon_offload) and fw4's flowtable settings.
'use strict';

import { readfile, writefile, popen, stat, mkdir, unlink, access, lsdir } from 'fs';
import { cursor } from 'uci';

const PORTS = [ 'lan0', 'lan1', 'lan2', 'lan3' ];
const COUNTERS = [ 'rx_bytes', 'tx_bytes', 'rx_packets', 'tx_packets', 'rx_dropped', 'tx_dropped' ];

function num(path) {
	const v = readfile(path);
	return v == null ? null : +trim(v);
}

function sh(cmd) {
	const p = popen(cmd);
	if (!p) return '';
	const out = p.read('all');
	p.close();
	return trim(out ?? '');
}

function q(s) {
	return `'${replace(s ?? '', "'", "'\\''")}'`;
}

function user_exists(name) {
	for (let line in split(readfile('/etc/passwd') ?? '', '\n'))
		if (split(line, ':')[0] == name) return true;
	return false;
}

// A factory-fresh /etc has root with an empty shadow field (stock OpenWrt): the UI's login page
// then offers to set one (er4.setup_password, allowed only while none is set), as LuCI does.
function root_has_password() {
	for (let line in split(readfile('/etc/shadow') ?? '', '\n')) {
		const f = split(line, ':');
		if (f[0] == 'root') return length(f[1] ?? '') > 0;
	}
	return false;
}

function passwd(u, p) {
	return system(`(echo ${q(p)}; sleep 1; echo ${q(p)}) | /bin/busybox passwd ${q(u)} >/dev/null 2>&1`) == 0;
}

function now_ms() {
	const t = clock();
	return t[0] * 1000 + int(t[1] / 1000000);
}

// kmod-octeon-offload's counters ("name value" lines); null when the module isn't loaded
function oo_stats() {
	const raw = readfile('/proc/octeon_offload');
	if (raw == null) return null;
	const out = {};
	for (let line in split(raw, '\n')) {
		const m = match(line, /^(\S+) (.*)$/);
		if (m) out[m[1]] = match(m[2], /^\d+$/) ? +m[2] : m[2];
	}
	return out;
}

// The router's ports in fw4's flowtable ("devices = { "lan0", "lan3" }"): fw4 lists the devices
// of its zones, so a port that isn't in use isn't there and isn't bound
function flowtable_ports() {
	const m = match(sh('nft list flowtables 2>/dev/null'), /devices = \{([^}]*)\}/);
	if (!m) return [];
	return filter(map(split(m[1], ','), (d) => trim(replace(d, '"', ''))), (d) => index(PORTS, d) >= 0);
}

// fw4's flow offloading switches (firewall.@defaults[0])
function flowtable() {
	const r = { software: false, hardware: false };
	cursor().foreach('firewall', 'defaults', function(s) {
		r.software = s.flow_offloading == '1';
		r.hardware = r.software && s.flow_offloading_hw == '1';
		return false;
	});
	return r;
}

function sample() {
	const cpu = { total: [], idle: [] };
	for (let line in split(readfile('/proc/stat') ?? '', '\n')) {
		const m = match(line, /^cpu\d+\s+(.*)$/);
		if (!m) continue;
		const f = map(split(trim(m[1]), /\s+/), (x) => +x);
		let total = 0;
		for (let x in f) total += x;
		push(cpu.total, total);
		push(cpu.idle, f[3] + f[4]);
	}
	const ports = {};
	for (let p in PORTS) {
		ports[p] = {};
		for (let c in COUNTERS)
			ports[p][c] = num(`/sys/class/net/${p}/statistics/${c}`) ?? 0;
	}
	const os = oo_stats();
	return {
		time: now_ms(),
		cpu,
		ports,
		// forwarded: packets the hardware fast path sent; no_flow: packets it looked at and passed to
		// the stack (no flow yet); flows_removed: flows dropped (firewall reloads, ports going down)
		offload: {
			flow_found: os?.forwarded ?? 0,
			flow_not_found: os?.no_flow ?? 0,
			invalidations: os?.flows_removed ?? 0
		},
		conntrack: {
			count: num('/proc/sys/net/netfilter/nf_conntrack_count') ?? 0,
			max: num('/proc/sys/net/netfilter/nf_conntrack_max') ?? 0
		}
	};
}

// History: rpcd keeps this plugin loaded, so samples taken by stats calls accumulate here;
// er4-statsmon calls stats every 5 s, so they do even with no UI open.
// Coarse buckets keep 24 h affordable: 2 s x 150, 15 s x 240, 120 s x 720.
const RINGS = { '300': { step: 2, keep: 150, s: [] }, '3600': { step: 15, keep: 240, s: [] }, '86400': { step: 120, keep: 720, s: [] } };
function remember(s) {
	for (let k, r in RINGS) {
		const last = r.s[length(r.s) - 1];
		if (last && s.time - last.time < r.step * 1000 - 500) continue;
		push(r.s, s);
		if (length(r.s) > r.keep) shift(r.s);
	}
}

// ---- system -------------------------------------------------------------------------
function release() {
	const r = {};
	for (let line in split(readfile('/etc/openwrt_release') ?? '', '\n')) {
		const m = match(line, /^DISTRIB_(\w+)='?([^']*)'?$/);
		if (m) r[lc(m[1])] = m[2];
	}
	return r;
}

// ---- diagnostics ----------------------------------------------------------------------
// rpcd is single-threaded, so a tool never runs inside a call: diag_start puts it in the
// background writing to DIAG/<id>.out (DIAG/<id>.rc when it ends) and the UI polls diag_poll.
const DIAG = '/tmp/er4-diag';
const DIAG_MAX_S = 90;          // watchdog: no job outlives this
let diag_seq = 0;

function host_ok(h) {
	// a name or an address; never starts with '-', so it can't become an option
	return type(h) == 'string' && match(h, /^[A-Za-z0-9][A-Za-z0-9.:_-]{0,252}$/) != null;
}

function diag_cmd(a) {
	const h = a.host, six = a.family == 6;
	if (!host_ok(h)) return null;
	switch (a.tool) {
	case 'ping':
		const n = type(a.count) == 'int' && a.count >= 1 && a.count <= 50 ? a.count : 5;
		return `${six ? 'ping6' : 'ping'} -c ${n} -W 2 ${q(h)}`;
	case 'traceroute':
		return `${six ? 'traceroute6' : 'traceroute'} -n -q 1 -w 2 -m 20 ${q(h)}`;
	case 'nslookup':
		if (a.server != null && !host_ok(a.server)) return null;
		return a.server != null ? `nslookup ${q(h)} ${q(a.server)}` : `nslookup ${q(h)}`;
	}
	return null;
}

function diag_id_ok(id) {
	return type(id) == 'string' && match(id, /^[0-9a-f]{1,16}$/) != null;
}

// Forget jobs older than 10 minutes; count the ones still running
function diag_sweep() {
	mkdir(DIAG);
	let running = 0;
	for (let f in lsdir(DIAG) ?? []) {
		const st = stat(`${DIAG}/${f}`);
		if (st && st.mtime < time() - 600) unlink(`${DIAG}/${f}`);
		else if (match(f, /\.pid$/) && !stat(`${DIAG}/${replace(f, /\.pid$/, '.rc')}`)) running++;
	}
	return running;
}

// "Thu Oct 15 12:00:00 2026 [1792087296.123] daemon.info dnsmasq[1234]: message" (logread -t)
// The saved log file (logread -F) has no [epoch]: the ctime date is all there is.
const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
function parse_logread(line) {
	let m = match(line, /^[^ ]+ [^ ]+ +[0-9]+ [0-9:]+ [0-9]+ \[([0-9]+)\.([0-9]+)\] ([a-z0-9]+)\.([a-z]+) (.*)$/);
	let time;
	if (m) time = +m[1] + +m[2] / 1000.0;
	else {
		const d = match(line, /^[^ ]+ ([A-Z][a-z]{2}) +([0-9]+) ([0-9]+):([0-9]+):([0-9]+) ([0-9]+) ([a-z0-9]+)\.([a-z]+) (.*)$/);
		if (!d) return { msg: line };
		time = timelocal({ year: +d[6], mon: MONTHS[d[1]] ?? 1, mday: +d[2], hour: +d[3], min: +d[4], sec: +d[5] });
		m = [ null, null, null, d[7], d[8], d[9] ];
	}
	const t = match(m[5], /^([^: ]+): ?(.*)$/);
	return { time, facility: m[3], level: m[4], tag: t ? t[1] : null, msg: t ? t[2] : m[5] };
}

// "<6>[   12.345678] message" (busybox dmesg -r): seconds since boot
function parse_dmesg(line) {
	const m = match(line, /^(<([0-9]+)>)?\[ *([0-9]+\.[0-9]+)\] ?(.*)$/);
	if (!m) return { msg: line };
	const LEVELS = [ 'emerg', 'alert', 'crit', 'err', 'warn', 'notice', 'info', 'debug' ];
	return { uptime: +m[3], level: m[2] != null ? LEVELS[+m[2] % 8] : null, msg: m[4] };
}

// One `conntrack -L -o extended` line:
// "ipv4 2 tcp 6 431999 ESTABLISHED src=A dst=B sport=1 dport=2 [packets= bytes=] src=B dst=C sport=2 dport=1 [ASSURED] mark=0 use=1"
// The first src/dst/sport/dport (and packets/bytes) are the original direction, the second the reply.
function parse_ct(line) {
	const f = split(trim(line), /[ \t]+/);
	if (length(f) < 6 || (f[0] != 'ipv4' && f[0] != 'ipv6')) return null;
	const c = { family: f[0] == 'ipv6' ? 6 : 4, proto: f[2], timeout: +f[4], flags: [] };
	const o = {}, r = {};
	for (let i = 5; i < length(f); i++) {
		const kv = match(f[i], /^([a-z_]+)=(.*)$/);
		if (kv) {
			const d = (kv[1] in o && index([ 'src', 'dst', 'sport', 'dport', 'packets', 'bytes', 'type', 'code', 'id' ], kv[1]) >= 0) ? r : o;
			d[kv[1]] = kv[2];
		}
		else if (match(f[i], /^\[[A-Z_]+\]$/))
			push(c.flags, substr(f[i], 1, length(f[i]) - 2));
		else if (i == 5 && match(f[i], /^[A-Z_]+$/))
			c.state = f[i];
	}
	c.src = o.src; c.dst = o.dst; c.reply_src = r.src; c.reply_dst = r.dst;
	if (o.sport != null) { c.sport = +o.sport; c.dport = +o.dport; c.reply_sport = +r.sport; c.reply_dport = +r.dport; }
	if (o.bytes != null) { c.bytes = +o.bytes; c.packets = +o.packets; c.reply_bytes = +r.bytes; c.reply_packets = +r.packets; }
	if (o.mark != null && o.mark != '0') c.mark = o.mark;
	if (o.helper != null) c.helper = o.helper;
	return c;
}

// "[options ]type base64[ comment]"; dropbear takes these key types
const AUTH_KEYS = '/etc/dropbear/authorized_keys';
const KEY_TYPES = [ 'ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521',
	'sk-ssh-ed25519@openssh.com', 'sk-ecdsa-sha2-nistp256@openssh.com' ];
function parse_key(l) {
	if (!length(l) || substr(l, 0, 1) == '#') return null;
	const f = split(l, /[ \t]+/);
	// options come first and may hold quoted spaces (command="..."), so look for the type anywhere
	for (let i = 0; i < length(f); i++) {
		if (index(KEY_TYPES, f[i]) >= 0 && i + 1 < length(f) && match(f[i + 1], /^[A-Za-z0-9+\/]+={0,3}$/))
			return { line: l, type: f[i], key: f[i + 1], comment: join(' ', slice(f, i + 2)) || null, options: i ? join(' ', slice(f, 0, i)) : null };
	}
	return null;
}

function read_keys() {
	const keys = [];
	for (let l in split(readfile(AUTH_KEYS) ?? '', '\n')) {
		const k = parse_key(trim(l));
		if (k) push(keys, k);
	}
	return keys;
}

function ip_json(args) {
	return json(sh(`ip -j ${args} 2>/dev/null`) || '[]') ?? [];
}

// ---- processes (er4.processes / er4.kill) --------------------------------------------------
// CPU % is the share of the whole machine (4 cores = 100 %) since the previous call (the page
// polls); the first call has nothing to compare with and reports null.
const PS_PREV = '/tmp/er4-ps.json';
function cpu_total() {
	const m = match(readfile('/proc/stat') ?? '', /^cpu +([0-9 ]+)/);
	let t = 0;
	for (let x in split(trim(m?.[1] ?? ''), / +/)) t += +x;
	return t;
}
function users() {
	const u = {};
	for (let l in split(readfile('/etc/passwd') ?? '', '\n')) {
		const f = split(l, ':');
		if (length(f) > 2) u[f[2]] = f[0];
	}
	return u;
}

// ---- packet capture (er4.capture_*) -----------------------------------------------------------
const CAP = '/tmp/er4-capture.pcap';
const CAP_PID = '/tmp/er4-capture.pid';
const CAP_LOG = '/tmp/er4-capture.log';
function cap_running() {
	const pid = +trim(readfile(CAP_PID) ?? '0');
	return type(pid) == 'int' && pid > 1 && access(`/proc/${pid}`) ? pid : 0;
}

// ---- crontab (er4.crontab / crontab_set) ------------------------------------------------------
const CRONTAB = '/etc/crontabs/root';
const CRON_FIELD = /^(\*|[0-9]+(-[0-9]+)?)(\/[0-9]+)?(,(\*|[0-9]+(-[0-9]+)?)(\/[0-9]+)?)*$/;
function cron_line_ok(l) {
	l = trim(l);
	if (l == '' || substr(l, 0, 1) == '#') return true;
	const f = split(l, /[ \t]+/);
	if (length(f) < 6) return false;
	for (let i = 0; i < 5; i++) if (!match(f[i], CRON_FIELD)) return false;
	return true;
}

// ---- optional features' packages (er4.packages / er4.pkg_install / er4.pkg_upgrade) -----------
// The official OpenWrt packages behind Tailscale, IPsec and the HTTPS certificate, installed and
// upgraded with apk on request. One job at a time, in the background (apk update runs first);
// the cards poll er4.packages for progress.
const PKG_SETS = {
	tailscale: [ 'tailscale' ],
	ipsec: [ 'strongswan-default', 'strongswan-pki', 'strongswan-mod-eap-identity', 'strongswan-mod-eap-mschapv2',
		'strongswan-mod-openssl', 'xfrm', 'kmod-xfrm-interface' ],
	acme: [ 'acme-acmesh', 'acme-acmesh-dnsapi' ]
};
// what says a feature is installed (the same files its status method checks)
const PKG_PROBE = { tailscale: '/usr/sbin/tailscale', ipsec: '/usr/sbin/swanctl', acme: '/usr/lib/acme/client/dnsapi/dns_cf.sh' };
const PKG_JOB = '/tmp/er4-pkg';      // .what (JSON: action, feature, packages), .pid, .log, .rc
const PKG_UPLOAD = '/tmp/er4-upload.apk';
// -> {action, feature, packages, running, rc (null while running), ok, log: last lines} | null before
// the first job. action: install|upgrade (a feature's set), add|del|upgrade (packages), upgrade-all,
// update (refresh the lists), add-file (the uploaded .apk)
function pkg_job(lines) {
	let what = null;
	try { what = json(readfile(`${PKG_JOB}.what`) ?? 'null'); } catch (e) {}
	if (type(what) != 'object') return null;
	const pid = trim(readfile(`${PKG_JOB}.pid`) ?? '');
	const rc = readfile(`${PKG_JOB}.rc`);
	const log = filter(split(trim(readfile(`${PKG_JOB}.log`) ?? ''), '\n'), length);
	// no pid yet: the job was started a moment ago (counts as running for a while, so a second
	// request can't start another apk next to it)
	const running = rc == null && (pid != '' ? system(`kill -0 ${int(pid)} 2>/dev/null`) == 0
		: time() - (stat(`${PKG_JOB}.what`)?.mtime ?? 0) < 30);
	// ok: apk succeeded. Its exit code alone can't say: a package left broken earlier (base-files
	// after a failed /rom/note on squashfs) makes every later run end in "1 error" and exit 1.
	// So: exit 0, or no ERROR line of this run's own and apk's summary line at the end.
	const code = rc == null ? null : +trim(rc);
	const ok = code == 0 || (code != null && !length(filter(log, (l) => match(l, /^ERROR/)))
		&& match(log[length(log) - 1] ?? '', /^[0-9]+ errors?; /) != null);
	return { action: what.action, feature: what.feature ?? null, packages: what.packages ?? [], running, rc: code, ok,
		log: slice(log, -(lines ?? 8)) };
}
// Start `cmd` as the package job (one at a time), described by `what` in pkg_job's reply
function pkg_run(what, cmd) {
	if (pkg_job()?.running) return { error: 'another package job is still running' };
	unlink(`${PKG_JOB}.rc`);
	unlink(`${PKG_JOB}.pid`);
	writefile(`${PKG_JOB}.what`, sprintf('%J', what));
	system(`sh -c ${q(`echo $$ > ${PKG_JOB}.pid; ( ${cmd} ) > ${PKG_JOB}.log 2>&1; echo $? > ${PKG_JOB}.rc`)} </dev/null >/dev/null 2>&1 &`);
	return {};
}
// package names as apk takes them, optionally pinned to a version (name=1.2.3-r1)
function pkg_names_ok(l) {
	return type(l) == 'array' && length(l) > 0 && length(l) <= 32 &&
		!length(filter(l, (n) => type(n) != 'string' || !match(n, /^[A-Za-z0-9][A-Za-z0-9._+-]*(=[A-Za-z0-9._+~-]+)?$/)));
}
function pkg_start(action, feature) {
	const set = PKG_SETS[feature];
	if (!set || (action != 'install' && action != 'upgrade')) return { error: 'unknown feature' };
	let cmd = `apk update && apk ${action == 'install' ? 'add' : 'upgrade'} ${join(' ', set)}`;
	// strongSwan's packages enable and start charon (UDP 500/4500) with nothing set up: off until
	// the VPN page saves the first remote (it enables swanctl then)
	if (feature == 'ipsec' && action == 'install')
		cmd += ' && { uci -q show ipsec | grep -q "=remote$" || { /etc/init.d/swanctl stop; /etc/init.d/swanctl disable; }; }';
	if (feature == 'tailscale' && action == 'upgrade')
		cmd += ' && { /etc/init.d/tailscale enabled && /etc/init.d/tailscale restart; true; }';
	return pkg_run({ action, feature, packages: set }, cmd);
}
// apk query's JSON, or null
function apk_query(args) {
	const out = sh(`apk query --format json ${args} 2>/dev/null`);
	if (!length(out)) return null;
	try { return json(out); } catch (e) { return null; }
}
// names in /etc/apk/world: what was asked for, as opposed to pulled in as a dependency
function apk_world() {
	const w = {};
	for (let l in split(readfile('/etc/apk/world') ?? '', '\n')) {
		const m = match(trim(l), /^([^=<>~ ]+)/);
		if (m) w[m[1]] = true;
	}
	return w;
}
// {name: new version} from `apk list -u` ("name-1.2-r1 arch {origin} (lic) [upgradable from: name-1.1-r1]")
// "name-version": the version starts at the last "-" that leaves a version ("6.12.112-r1",
// "1718~981c978eff"), so "kmod-nft-offload-6.12.112-r2" is kmod-nft-offload at 6.12.112-r2
function apk_split(nv) {
	const m = match(nv, /^(.+)-([0-9][^-]*(-r[0-9]+)?)$/);
	return m ? [ m[1], m[2] ] : null;
}
function apk_upgradable() {
	const u = {};
	for (let l in split(sh('apk list -u 2>/dev/null'), '\n')) {
		const m = match(l, /^(\S+) .*\[upgradable from: (\S+)\]/);
		const n = m && apk_split(m[1]);
		if (n) u[n[0]] = n[1];
	}
	return u;
}

// ---- Tailscale (er4.tailscale_*) -------------------------------------------------------------
// OpenWrt's tailscale package (installed by er4.pkg_install, updated by er4.pkg_upgrade: Tailscale
// can't update a package-managed install itself).
const TS = '/usr/sbin/tailscale';
// the package job as the card's install progress: {state: downloading|ok|error, message}
function ts_install_state() {
	const j = pkg_job();
	if (!j || j.feature != 'tailscale' || j.action != 'install') return null;
	if (j.running) return { state: 'downloading', message: null };
	return j.ok ? { state: 'ok', message: null } : { state: 'error', message: j.log[length(j.log) - 1] ?? 'install failed' };
}
function ts_json(args) {
	const out = sh(`${TS} ${args} 2>/dev/null`);
	return length(out) ? json(out) : null;
}
function cidr_ok(c) {
	return type(c) == 'string' && (match(c, /^([0-9]{1,3}\.){3}[0-9]{1,3}\/([0-9]|[12][0-9]|3[0-2])$/) || match(c, /^[0-9a-fA-F:]+\/[0-9]{1,3}$/));
}

// ---- IPsec / IKEv2 (er4.ipsec_*; config is UCI 'ipsec', rendered by /etc/init.d/swanctl) ------
const SWAN = '/etc/swanctl';
// `swanctl --list-sas --pretty`: "name {", "key = value", "key = [", "item", "]", "}" per line
function parse_pretty(text) {
	const root = {}, stack = [ root ];
	let list = null;
	for (let l in split(text, '\n')) {
		l = trim(l);
		if (l == '') continue;
		const top = stack[length(stack) - 1];
		if (list != null) {
			if (l == ']') list = null;
			else push(list, l);
			continue;
		}
		let m;
		if (l == '}') { if (length(stack) > 1) pop(stack); }
		else if ((m = match(l, /^(.+?) \{$/))) {
			// one "list-sa event {" per SA: keep each
			let k = m[1];
			for (let i = 2; k in top; i++) k = `${m[1]}#${i}`;
			const o = {}; top[k] = o; push(stack, o);
		}
		else if ((m = match(l, /^([^ =]+) = \[$/))) { list = []; top[m[1]] = list; }
		else if ((m = match(l, /^([^ =]+) = (.*)$/))) top[m[1]] = m[2];
	}
	return root;
}
function cert_info(path) {
	if (!access(path)) return null;
	const out = sh(`pki --print --in ${q(path)} 2>/dev/null`);
	return {
		subject: trim(match(out, /subject: +"?([^"\n]*)/)?.[1] ?? ''),
		san: map(match(out, /altNames: +([^\n]*)/)?.[1] ? split(match(out, /altNames: +([^\n]*)/)[1], /, */) : [], trim),
		not_after: trim(match(out, /not after +([^\n,]*)/)?.[1] ?? '')
	};
}

// ---- HTTPS certificate (er4.acme_*; acme.sh via UCI 'acme', section 'er4'; /usr/libexec/er4-https) --
// A Let's Encrypt certificate for <domain> and *.<domain> by DNS-01 through Cloudflare, so nothing
// opens on the WAN. <host>.<domain> resolves to the router's LAN address in dnsmasq (dhcp.er4_https).
const ACME = '/usr/lib/acme/client';
function acme_names() {
	const d = cursor().get('acme', 'er4', 'domains');
	return type(d) == 'array' ? d : [];
}
function lan_addr() {
	let a = cursor().get('network', 'lan', 'ipaddr');
	if (type(a) == 'array') a = a[0];
	return type(a) == 'string' ? split(a, '/')[0] : null;
}
function x509_info(path) {
	if (!access(path)) return null;
	const out = sh(`openssl x509 -in ${q(path)} -noout -issuer -startdate -enddate -ext subjectAltName 2>/dev/null`);
	if (!length(out)) return null;
	const end = match(out, /notAfter=([^\n]*)/)?.[1];
	const days = end ? int((+sh(`date -D '%b %d %H:%M:%S %Y GMT' -d ${q(replace(end, /  +/g, ' '))} +%s 2>/dev/null`) - time()) / 86400) : null;
	return {
		issuer: trim(match(out, /issuer=.*O ?= ?([^,\n]*)/)?.[1] ?? match(out, /issuer=([^\n]*)/)?.[1] ?? ''),
		names: map(filter(split(match(out, /DNS:[^\n]*/)?.[0] ?? '', /, */), length), (n) => replace(n, /^DNS:/, '')),
		not_before: match(out, /notBefore=([^\n]*)/)?.[1], not_after: end, days
	};
}
function acme_running() {
	const st = json(sh(`ubus call service list '{"name":"acme"}' 2>/dev/null`) || '{}');
	for (let n, i in st?.acme?.instances ?? {}) if (i.running) return true;
	return false;
}

const methods = {
	stats: {
		call: function() {
			const s = sample();
			remember(s);
			return s;
		}
	},

	history: {
		args: { window: 300 },
		call: function(req) {
			const r = RINGS[`${req.args?.window ?? 300}`] ?? RINGS['300'];
			return { step: r.step, samples: r.s };
		}
	},

	// kmod-octeon-offload and fw4's flowtable settings. ports: how many ports the module is bound
	// on (should be length(ports_wanted)); counters: everything /proc/octeon_offload has.
	offload: {
		call: function() {
			const os = oo_stats();
			const ft = flowtable();
			return {
				loaded: os != null,
				hooks: os?.driver_hooks == 'yes',
				software: ft.software,
				hardware: ft.hardware,
				ports: os ? (os.flowtable_binds ?? 0) - (os.flowtable_unbinds ?? 0) : 0,
				// the Octeon ports fw4 put in its flowtable: every one should be bound
				ports_wanted: flowtable_ports(),
				flows: os?.flows ?? 0,
				max_flows: os?.max_flows ?? 0,
				counters: os ?? {}
			};
		}
	},

	neighbors: {
		call: function() {
			const out = [];
			// "IP dev DEV [lladdr MAC] [router] STATE"
			for (let line in split(sh('ip -4 neigh show'), '\n')) {
				const f = split(trim(line), /\s+/);
				if (length(f) < 4 || f[1] != 'dev') continue;
				const ll = index(f, 'lladdr');
				push(out, { ip: f[0], dev: f[2], mac: ll >= 0 ? f[ll + 1] : '', state: f[length(f) - 1] });
			}
			return { neighbors: out };
		}
	},

	// -> {tailscale, ipsec, acme: installed?, job: the current or last package job (see pkg_job)}
	packages: {
		call: function() {
			const r = { job: pkg_job() };
			for (let f, path in PKG_PROBE) r[f] = !!access(path);
			return r;
		}
	},

	// {feature: tailscale|ipsec|acme} -> {} | {error}: apk add / apk upgrade its packages, in the
	// background; progress in packages.job
	pkg_install: {
		args: { feature: '' },
		call: function(req) { return pkg_start('install', req.args.feature); }
	},
	pkg_upgrade: {
		args: { feature: '' },
		call: function(req) { return pkg_start('upgrade', req.args.feature); }
	},

	// ---- software: apk ---------------------------------------------------------------------
	// -> {packages: [{name, version, description, size, world, upgrade}], updated: mtime of the
	// lists, job}. world: asked for (in /etc/apk/world), not just a dependency; upgrade: newer version
	pkg_list: {
		call: function() {
			const world = apk_world(), up = apk_upgradable();
			const pk = map(apk_query('--fields name,version,description,installed-size --installed "*"') ?? [], (p) => ({
				name: p.name, version: p.version, description: p.description, size: p['installed-size'] ?? 0,
				world: !!world[p.name], upgrade: up[p.name] ?? null
			}));
			let updated = 0;
			for (let f in lsdir('/tmp/apk-cache') ?? []) updated = max(updated, stat(`/tmp/apk-cache/${f}`)?.mtime ?? 0);
			for (let f in lsdir('/var/cache/apk') ?? []) updated = max(updated, stat(`/var/cache/apk/${f}`)?.mtime ?? 0);
			return { packages: pk, updated, job: pkg_job() };
		}
	},

	// {query} -> {packages: [{name, version, description, size, installed}], more: bool}: available
	// packages whose name or description matches (at most 200, names first)
	pkg_search: {
		args: { query: '' },
		call: function(req) {
			const qs = trim(req.args.query ?? '');
			if (length(qs) < 2 || !match(qs, /^[A-Za-z0-9._+ -]+$/)) return { packages: [], more: false };
			const inst = {};
			for (let p in apk_query('--fields name,version --installed "*"') ?? []) inst[p.name] = p.version;
			const all = apk_query(`--fields name,version,description,file-size --available --match name,description ${q(`*${qs}*`)}`) ?? [];
			const l = lc(qs);
			const rank = (p) => (lc(p.name) == l ? 0 : index(lc(p.name), l) >= 0 ? 1 : 2);
			const seen = {}, out = [];
			for (let p in sort(all, (a, b) => rank(a) - rank(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
				if (seen[p.name]) continue;
				seen[p.name] = true;
				push(out, { name: p.name, version: p.version, description: p.description, size: p['file-size'] ?? 0, installed: inst[p.name] ?? null });
			}
			return { packages: slice(out, 0, 200), more: length(out) > 200 };
		}
	},

	// {name} -> {name, version, description, url, license, size, download, depends, required_by,
	// installed, world} | {error}. required_by: installed packages that depend on it
	pkg_info: {
		args: { name: '' },
		call: function(req) {
			const n = req.args.name;
			if (!pkg_names_ok([ n ])) return { error: 'bad name' };
			const p = apk_query(`--fields name,version,description,url,license,installed-size,file-size,depends --match name ${q(n)}`)?.[0];
			if (!p) return { error: 'no such package' };
			const i = apk_query(`--fields name,version,reverse-depends --installed --match name ${q(n)}`)?.[0];
			return { name: p.name, version: p.version, description: p.description, url: p.url, license: p.license,
				size: p['installed-size'] ?? 0, download: p['file-size'] ?? 0, depends: p.depends ?? [],
				required_by: i?.['reverse-depends'] ?? [], installed: i?.version ?? null, world: !!apk_world()[n] };
		}
	},

	// {action: add|del|upgrade|upgrade-all|update|add-file, packages?: [name]} -> {} | {error}: the
	// package job (progress in pkg_list.job / packages.job). add-file installs the uploaded .apk
	// (PKG_UPLOAD, unsigned: --allow-untrusted). add and upgrade refresh the lists first.
	pkg_action: {
		args: { action: '', packages: [] },
		call: function(req) {
			const a = req.args.action, l = req.args.packages ?? [];
			const names = () => join(' ', map(l, q));
			switch (a) {
			case 'add':
			case 'upgrade':
			case 'del':
				if (!pkg_names_ok(l)) return { error: 'bad package names' };
				return pkg_run({ action: a, packages: l }, a == 'del' ? `apk del ${names()}` : `apk update && apk ${a} ${names()}`);
			case 'upgrade-all':
				return pkg_run({ action: a, packages: [] }, 'apk update && apk upgrade');
			case 'update':
				return pkg_run({ action: a, packages: [] }, 'apk update');
			case 'add-file':
				if (!stat(PKG_UPLOAD)) return { error: 'no package uploaded' };
				return pkg_run({ action: a, packages: [] }, `apk add --allow-untrusted ${PKG_UPLOAD}; rc=$?; rm -f ${PKG_UPLOAD}; exit $rc`);
			}
			return { error: 'unknown action' };
		}
	},

	// {lines} -> the package job with more of its log (the Software page's log view)
	pkg_job: {
		args: { lines: 200 },
		call: function(req) { return pkg_job(min(int(req.args.lines ?? 200), 2000)) ?? {}; }
	},

	// ---- firmware: OpenWrt's sysupgrade -----------------------------------------------------
	// -> {release, board, model, kernel, hooks: the running kernel has the Octeon offload hooks}
	firmware_info: {
		call: function() {
			return {
				release: release(),
				board: trim(readfile('/tmp/sysinfo/board_name') ?? ''),
				model: trim(readfile('/tmp/sysinfo/model') ?? ''),
				kernel: trim(sh('uname -r')),
				hooks: oo_stats()?.driver_hooks == 'yes'
			};
		}
	},

	// {path} -> {valid, checks: [{id, label, ok (true|false|null = information), detail}], image: {size, sha256}}
	// | {error}. valid: sysupgrade accepts it for this board. The offload check only warns: an
	// image without the driver hooks (an official build) works, but nothing is offloaded in hardware.
	firmware_verify: {
		args: { path: '' },
		call: function(req) {
			const path = req.args.path;
			if (path != '/tmp/firmware.bin') return { error: 'bad path' };
			const st = stat(path);
			if (!st) return { error: 'no image uploaded' };
			const checks = [];
			const board = trim(readfile('/tmp/sysinfo/board_name') ?? '');
			const dir = `sysupgrade-${replace(board, ',', '_')}/`;
			const members = sh(`tar -tf ${q(path)} 2>/dev/null`);
			const ours = index(split(members, '\n'), dir) >= 0;
			push(checks, { id: 'board', label: `Built for ${board}`, ok: ours,
				detail: ours ? `contains ${dir}` : (length(members) ? 'not a sysupgrade image for this router' : 'not a sysupgrade image (.tar)') });
			const t = sh(`sysupgrade -T ${q(path)} 2>&1; echo "rc=$?"`);
			const ok = match(t, /rc=0$/) != null;
			push(checks, { id: 'sysupgrade', label: 'sysupgrade accepts it', ok,
				detail: join('; ', filter(map(split(replace(t, /rc=[0-9]+$/, ''), '\n'), (l) => trim(replace(l, /^.*upgrade: /, ''))), length)) || (ok ? 'ok' : 'refused') });
			if (ours) {
				// one substring search in memory: busybox grep takes ~15 s over a 12 MB binary
				const k = '/tmp/er4-fw-kernel';
				system(`tar -xOf ${q(path)} ${q(dir + 'kernel')} > ${k} 2>/dev/null`);
				const hooks = index(readfile(k) ?? '', 'cvm_oct_offload_register') >= 0;
				unlink(k);
				push(checks, { id: 'offload', label: 'Has the Octeon offload driver hooks (patch 703)', ok: hooks,
					detail: hooks ? 'hardware offload keeps working' : 'an official build: it works, but nothing is offloaded in hardware' });
			}
			const sha256 = split(sh(`sha256sum ${q(path)}`), ' ')[0];
			push(checks, { id: 'sha256', label: 'SHA-256', ok: null, detail: sha256 });
			return { valid: ours && ok, checks, image: { size: st.size, sha256 } };
		}
	},

	// {path, keep: bool} -> {} | {error}: sysupgrade in two seconds (it reboots); keep: settings too
	firmware_install: {
		args: { path: '', keep: true },
		call: function(req) {
			const path = req.args.path;
			if (path != '/tmp/firmware.bin' || !stat(path)) return { error: 'no image uploaded' };
			if (system(`sysupgrade -T ${q(path)} >/dev/null 2>&1`) != 0) return { error: 'sysupgrade refuses this image' };
			system(`(sleep 2; sysupgrade ${req.args.keep === false ? '-n ' : ''}${q(path)}) </dev/null >/dev/null 2>&1 &`);
			return {};
		}
	},

	// procd's system.reboot starts the shutdown before it answers, so the reply (and the UI's
	// wait screen) can be lost with the network: answer first, reboot two seconds later.
	reboot: {
		call: function() {
			system('(sleep 2; reboot) >/dev/null 2>&1 &');
			return {};
		}
	},

	config_inspect: {
		args: { path: '' },
		call: function(req) {
			const files = filter(split(sh(`tar -tzf ${q(req.args.path)} 2>/dev/null`), '\n'), length);
			if (!length(files)) return { valid: false, files: [], error: 'not a configuration backup (tar.gz)' };
			const host = sh(`tar -xzOf ${q(req.args.path)} etc/config/system 2>/dev/null | sed -n "s/.*option hostname '\\?\\([^']*\\)'\\?/\\1/p" | head -1`);
			return { valid: true, hostname: host || null, files };
		}
	},

	config_restore: {
		args: { path: '' },
		call: function(req) {
			// /etc is the persistent overlay: copying a backup's etc/ into it is the restore.
			// Checked before anything is written: every member under etc/, no '..', no hard links,
			// and nothing below a symlink the archive itself creates (extraction would write
			// through it, e.g. etc/x -> /usr/bin then etc/x/sh).
			const path = req.args.path;
			const list = filter(split(sh(`tar -tvzf ${q(path)} 2>/dev/null`), '\n'), length);
			if (!length(list)) return { error: 'not a configuration backup (tar.gz)' };
			const links = {}, names = [];
			for (let l in list) {
				const arrow = index(l, ' -> ');
				const head = arrow >= 0 ? substr(l, 0, arrow) : l;
				const name = replace(match(head, /([^ ]+)$/)?.[1] ?? '', /^\.\//, '');
				if (substr(l, 0, 1) == 'h' || index(l, ' link to ') >= 0) return { error: `refusing hard link ${name}` };
				if (!match(name, /^etc(\/|$)/) || match(name, /(^|\/)\.\.(\/|$)/)) return { error: `refusing ${name}: only etc/ is restored` };
				if (substr(l, 0, 1) == 'l') links[replace(name, /\/$/, '')] = true;
				push(names, name);
			}
			for (let n in names) {
				const parts = split(replace(n, /\/$/, ''), '/');
				for (let i = 1; i < length(parts); i++)
					if (links[join('/', slice(parts, 0, i))]) return { error: `refusing ${n}: below a symlink in the archive` };
			}
			const stage = '/tmp/er4-restore';
			system(`rm -rf ${stage}; mkdir -p ${stage}`);
			const ok = system(`tar -xzf ${q(path)} -C ${stage} && [ -d ${stage}/etc ] && cp -a ${stage}/etc/. /etc/ && sync`) == 0;
			system(`rm -rf ${stage}`);
			if (!ok) return { error: 'restore failed' };
			system('(sleep 2; reboot) >/dev/null 2>&1 &');
			return {};
		}
	},

	factory_reset: {
		call: function() {
			// OpenWrt's own reset: wipe the overlay, defaults come back on the next boot
			system('(sleep 2; firstboot -y; reboot) >/dev/null 2>&1 &');
			return {};
		}
	},

	// The methods below replace the few LuCI backend calls the UI used (luci.setPassword,
	// luci.getTimezones, luci.setLocaltime, luci.wireguard.*), so it doesn't need luci-base.


	set_password: {
		args: { username: 'root', password: 'password' },
		call: function(req) {
			const u = req.args.username ?? 'root', p = req.args.password;
			if (!match(u, /^[a-z_][a-z0-9_-]{0,31}$/) || !user_exists(u))
				return { result: false, error: 'unknown user' };
			if (type(p) != 'string' || !length(p) || index(p, '\n') >= 0)
				return { result: false, error: 'bad password' };
			return { result: passwd(u, p) };
		}
	},

	// First-boot setup: the only er4 calls the logged-out session may make
	// (ACL group "unauthenticated"). setup_password works only while root has no password.
	setup_status: {
		call: function() {
			return { password_set: root_has_password() };
		}
	},

	setup_password: {
		args: { password: 'password' },
		call: function(req) {
			const p = req.args.password;
			if (root_has_password()) return { result: false, error: 'a password is already set' };
			if (type(p) != 'string' || length(p) < 8 || index(p, '\n') >= 0)
				return { result: false, error: 'bad password' };
			return { result: passwd('root', p) };
		}
	},

	timezones: {
		call: function() {
			const zones = json(readfile('/usr/share/er4/zoneinfo.json') ?? '{}');
			const active = cursor().get('system', '@system[0]', 'zonename') ?? 'UTC';
			const out = {};
			for (let name, tzstring in zones)
				out[name] = name == active ? { tzstring, active: true } : { tzstring };
			return out;
		}
	},

	set_localtime: {
		args: { localtime: 0 },
		call: function(req) {
			const t = localtime(req.args.localtime);
			if (type(req.args.localtime) != 'int' || !t)
				return { result: false };
			system(sprintf('date -s "%04d-%02d-%02d %02d:%02d:%02d" >/dev/null', t.year, t.mon, t.mday, t.hour, t.min, t.sec));
			system('/etc/init.d/sysfixtime restart >/dev/null 2>&1');
			return { result: req.args.localtime };
		}
	},

	// Same reply shape as luci.wireguard getWgInstances: { <iface>: { name, public_key,
	// listen_port, fwmark, peers: [{ name, public_key, endpoint, allowed_ips, latest_handshake,
	// transfer_rx, transfer_tx, persistent_keepalive }] } }. Peer names come from UCI.
	wg_instances: {
		call: function() {
			const out = {}, names = {};
			const uci = cursor();
			uci.foreach('network', null, (s) => {
				if (substr(s['.type'], 0, 10) == 'wireguard_' && s.public_key)
					names[`${substr(s['.type'], 10)}/${s.public_key}`] = s.description;
			});
			for (let line in split(sh('wg show all dump 2>/dev/null'), '\n')) {
				const f = split(line, '\t');
				if (length(f) == 5) {
					// interface: name, private key, public key, listen port, fwmark
					out[f[0]] = { name: f[0], public_key: f[2], listen_port: f[3], fwmark: f[4], peers: [] };
				}
				else if (length(f) == 9 && out[f[0]]) {
					// peer: iface, public key, psk, endpoint, allowed ips, handshake, rx, tx, keepalive
					push(out[f[0]].peers, {
						name: names[`${f[0]}/${f[1]}`],
						public_key: f[1],
						endpoint: f[3],
						allowed_ips: f[4] == '(none)' || !length(f[4]) ? [] : split(f[4], ','),
						latest_handshake: f[5],
						transfer_rx: f[6],
						transfer_tx: f[7],
						persistent_keepalive: f[8]
					});
				}
			}
			return out;
		}
	},

	// Fallback for browsers without X25519 (the UI generates keys locally when it can)
	wg_keypair: {
		call: function() {
			const priv = sh('wg genkey 2>/dev/null');
			const pub = length(priv) ? sh(`echo ${q(priv)} | wg pubkey 2>/dev/null`) : '';
			return { keys: { priv, pub } };
		}
	},

	// System log (logd's ring buffer) or kernel log (dmesg), newest last.
	// {source: 'system'|'kernel', lines} -> {source, boot, lines: [{time?|uptime?, facility?, level?, tag?, msg}]}
	// boot is the boot time (unix s), to place dmesg's seconds-since-boot on the clock.
	log: {
		args: { source: 'system', lines: 500 },
		call: function(req) {
			const n = type(req.args.lines) == 'int' && req.args.lines > 0 ? min(req.args.lines, 5000) : 500;
			const kernel = req.args.source == 'kernel';
			let raw;
			if (req.args.source == 'saved') {
				// the log file the log service keeps (System > Logging), with its rotated .old first
				const f = cursor().get_first('system', 'system', 'log_file');
				if (!f) return { error: 'no log file configured' };
				raw = sh(`cat ${q(f + '.old')} ${q(f)} 2>/dev/null | tail -n ${n}`);
			}
			else raw = kernel ? sh(`dmesg -r 2>/dev/null | tail -n ${n}`) : sh(`logread -t -l ${n} 2>/dev/null`);
			const up = +split(readfile('/proc/uptime') ?? '0', ' ')[0];
			const lines = [];
			for (let l in split(raw, '\n'))
				if (length(l)) push(lines, kernel ? parse_dmesg(l) : parse_logread(l));
			return { source: kernel ? 'kernel' : req.args.source == 'saved' ? 'saved' : 'system', boot: time() - int(up), lines };
		}
	},

	// Routing tables and neighbours, as `ip -j` prints them (all tables; the UI filters).
	routes: {
		call: function() {
			return {
				ipv4: ip_json('-4 route show table all'),
				ipv6: ip_json('-6 route show table all'),
				neigh: [ ...ip_json('-4 neigh show'), ...ip_json('-6 neigh show') ]
			};
		}
	},

	// WAN health from er4-wanmon (a ping to the gateway and to the internet every 10 s, in /tmp)
	// and WAN up/down events from the iface hotplug hook. {window: seconds (max 86400)} ->
	// {step, target, samples: [{t, gw_rtt, gw_loss, inet_rtt, inet_loss}], events: [{t, action, iface}]}
	// Buckets of `step` seconds: rtt is the mean of the replies (null: none), loss 0..1.
	wan_health: {
		args: { window: 3600 },
		call: function(req) {
			const win = type(req.args.window) == 'int' && req.args.window > 0 ? min(req.args.window, 86400) : 3600;
			const step = max(10, int(win / 720 / 10) * 10 || 10);
			const since = time() - win;
			const b = {};
			for (let l in split(readfile('/tmp/er4-wan.tsv') ?? '', '\n')) {
				const f = split(l, ' ');
				if (length(f) != 3 || +f[0] < since) continue;
				const k = int(+f[0] / step) * step;
				const x = b[k] ??= { n: 0, gw: 0, gwn: 0, in: 0, inn: 0 };
				x.n++;
				if (f[1] != '-') { x.gw += +f[1]; x.gwn++; }
				if (f[2] != '-') { x.in += +f[2]; x.inn++; }
			}
			const samples = [];
			for (let k in sort(keys(b), (p, q) => +p - +q)) {
				const x = b[k];
				push(samples, {
					t: +k,
					gw_rtt: x.gwn ? x.gw / x.gwn : null, gw_loss: (x.n - x.gwn) / x.n,
					inet_rtt: x.inn ? x.in / x.inn : null, inet_loss: (x.n - x.inn) / x.n
				});
			}
			const events = [];
			for (let l in split(readfile('/tmp/er4-wan-events') ?? '', '\n')) {
				const f = split(l, ' ');
				if (length(f) == 3 && +f[0] >= since) push(events, { t: +f[0], action: f[1], iface: f[2] });
			}
			return { step, target: '1.1.1.1', running: system('pidof er4-wanmon >/dev/null 2>&1') == 0, samples, events };
		}
	},

	// SSH keys that may log in as root (dropbear's /etc/dropbear/authorized_keys).
	// -> {keys: [{line, type, comment}]}
	ssh_keys: {
		call: function() {
			return { keys: read_keys() };
		}
	},

	// Replace the key list. {keys: [line, ...]} -> {keys} | {error}. Every line must parse as a
	// public key (options allowed); nothing is written otherwise.
	ssh_keys_set: {
		args: { keys: [ 'line' ] },
		call: function(req) {
			const lines = req.args.keys;
			if (type(lines) != 'array' || length(lines) > 64) return { error: 'bad arguments' };
			const out = [];
			for (let l in lines) {
				if (type(l) != 'string' || index(l, '\n') >= 0 || !parse_key(trim(l)))
					return { error: `not a public key: ${substr(l ?? '', 0, 40)}` };
				push(out, trim(l));
			}
			mkdir('/etc/dropbear');
			const tmp = `${AUTH_KEYS}.new`;
			if (!writefile(tmp, length(out) ? join('\n', out) + '\n' : '') ||
			    system(`chmod 600 ${tmp} && mv ${tmp} ${AUTH_KEYS}`) != 0)
				return { error: 'cannot write authorized_keys' };
			return { keys: read_keys() };
		}
	},

	// Restart one interface: `ifup` takes it down and up again (DHCP renews, PPPoE redials).
	// One call on the router, so restarting the network the browser uses still comes back up.
	iface_restart: {
		args: { name: 'lan' },
		call: function(req) {
			const n = req.args.name;
			if (type(n) != 'string' || n == 'loopback' || !match(n, /^[A-Za-z0-9_]{1,15}$/) ||
			    cursor().get('network', n) != 'interface')
				return { error: 'no such interface' };
			system(`(sleep 1; ifup ${n}) </dev/null >/dev/null 2>&1 &`);
			return {};
		}
	},

	// The connection tracking table: /proc/net/nf_conntrack (stock OpenWrt has it), else
	// conntrack-tools if installed. {limit} -> {count, max, offload, flows: [...]} (see parse_ct).
	// A flow nf_flowtable took over carries the OFFLOAD flag, HW_OFFLOAD once the hardware
	// (kmod-octeon-offload) holds it too.
	conntrack: {
		args: { limit: 2000 },
		call: function(req) {
			const n = type(req.args.limit) == 'int' && req.args.limit > 0 ? min(req.args.limit, 10000) : 2000;
			const flows = [];
			let raw = readfile('/proc/net/nf_conntrack');
			if (raw == null) raw = sh('conntrack -L -o extended 2>/dev/null');
			for (let l in split(raw ?? '', '\n')) {
				if (length(flows) >= n) break;
				const c = parse_ct(l);
				if (!c) continue;
				if (index(c.flags, 'HW_OFFLOAD') >= 0) c.offload = 'hw';
				else if (index(c.flags, 'OFFLOAD') >= 0) c.offload = 'sw';
				push(flows, c);
			}
			const ft = flowtable();
			return {
				count: num('/proc/sys/net/netfilter/nf_conntrack_count') ?? length(flows),
				max: num('/proc/sys/net/netfilter/nf_conntrack_max') ?? 0,
				offload: { software: ft.software, hardware: ft.hardware && oo_stats() != null },
				flows
			};
		}
	},

	// What fw4 actually loaded: {ruleset: `nft list ruleset` text, counters: {name: {packets, bytes}}}.
	// fw4 tags every rule it generates with comment "!fw4: <section name>" and a counter; one UCI
	// section can become several nft rules (families, protocols), so they are summed per name.
	firewall_status: {
		call: function() {
			const counters = {};
			const j = json(sh('nft -j list ruleset 2>/dev/null') || '{}');
			for (let o in j?.nftables ?? []) {
				const r = o.rule;
				const m = r ? match(r.comment ?? '', /^!fw4: (.+)$/) : null;
				if (!m) continue;
				for (let e in r.expr ?? []) {
					if (!e.counter) continue;
					const c = counters[m[1]] ??= { packets: 0, bytes: 0 };
					c.packets += e.counter.packets ?? 0;
					c.bytes += e.counter.bytes ?? 0;
				}
			}
			const text = sh('nft list ruleset 2>&1');
			return { ruleset: length(text) > 262144 ? substr(text, 0, 262144) : text, counters };
		}
	},

	// -> {processes: [{pid, ppid, user, state, cpu (% of the machine, null on the first call), rss (KiB), mem (%), command}]}
	processes: {
		call: function() {
			const prev = json(readfile(PS_PREV) ?? '{}') ?? {};
			const total = cpu_total(), dt = total - (prev.total ?? 0);
			const memtotal = +(match(readfile('/proc/meminfo') ?? '', /MemTotal: +([0-9]+)/)?.[1] ?? 0);
			const who = users(), ticks = {}, out = [];
			for (let d in lsdir('/proc') ?? []) {
				if (!match(d, /^[0-9]+$/)) continue;
				const st = readfile(`/proc/${d}/stat`);
				if (!st) continue;
				const r = rindex(st, ')');
				const comm = substr(st, index(st, '(') + 1, r - index(st, '(') - 1);
				const f = split(substr(st, r + 2), ' ');	// f[0] = state (field 3)
				const t = +f[11] + +f[12];	// utime + stime
				ticks[d] = t;
				const status = readfile(`/proc/${d}/status`) ?? '';
				const uid = match(status, /\nUid:\t([0-9]+)/)?.[1];
				const rss = +(match(status, /\nVmRSS:\s+([0-9]+)/)?.[1] ?? 0);
				let cmd = trim(replace(readfile(`/proc/${d}/cmdline`) ?? '', /\x00/g, ' '));
				push(out, {
					pid: +d, ppid: +f[1], state: f[0], user: who[uid] ?? uid, rss,
					mem: memtotal ? rss * 100.0 / memtotal : 0,
					cpu: prev.ticks?.[d] != null && dt > 0 ? (t - prev.ticks[d]) * 100.0 / dt : null,
					command: length(cmd) ? cmd : `[${comm}]`
				});
			}
			writefile(PS_PREV, sprintf('%J', { total, ticks }));
			return { processes: out };
		}
	},

	// {pid, signal: 'HUP'|'TERM'|'KILL'} -> {} | {error}
	kill: {
		args: { pid: 0, signal: 'TERM' },
		call: function(req) {
			const pid = req.args.pid, sig = req.args.signal;
			if (type(pid) != 'int' || pid <= 1 || !(sig in [ 'HUP', 'TERM', 'KILL' ])) return { error: 'bad arguments' };
			if (!access(`/proc/${pid}`)) return { error: 'no such process' };
			return system([ 'kill', `-${sig}`, `${pid}` ]) == 0 ? {} : { error: 'kill failed' };
		}
	},

	// -> {text, enabled (cron starts at boot), running}
	crontab: {
		call: function() {
			return {
				text: readfile(CRONTAB) ?? '',
				enabled: system('/etc/init.d/cron enabled') == 0,
				running: sh('pidof crond') != ''
			};
		}
	},

	// {text} -> {} | {error, line}: writes root's crontab, enables and restarts cron (or stops it when empty)
	crontab_set: {
		args: { text: 'text' },
		call: function(req) {
			const text = req.args.text;
			if (type(text) != 'string' || length(text) > 16384) return { error: 'bad arguments' };
			const lines = split(text, '\n');
			for (let i = 0; i < length(lines); i++)
				if (!cron_line_ok(lines[i])) return { error: 'not a cron line', line: i + 1 };
			mkdir('/etc/crontabs');
			writefile(CRONTAB, length(trim(text)) ? trim(text) + '\n' : '');
			const any = filter(lines, (l) => length(trim(l)) && substr(trim(l), 0, 1) != '#');
			if (length(any)) system('/etc/init.d/cron enable; /etc/init.d/cron restart >/dev/null 2>&1');
			else system('/etc/init.d/cron stop >/dev/null 2>&1; /etc/init.d/cron disable');
			return {};
		}
	},

	// {iface, filter?, seconds (≤ 300), packets (≤ 200000)} -> {} | {error}
	// tcpdump into /tmp (RAM), at most 20 MB; read back with cgi-download (er4.acl.json).
	// Offloaded flows skip the kernel after their first packets, so tcpdump doesn't see them.
	capture_start: {
		args: { iface: 'iface', filter: 'filter', seconds: 30, packets: 10000 },
		call: function(req) {
			const a = req.args;
			if (cap_running()) return { error: 'a capture is already running' };
			if (type(a.iface) != 'string' || !match(a.iface, /^[A-Za-z0-9._-]{1,15}$/) || (a.iface != 'any' && !access(`/sys/class/net/${a.iface}`)))
				return { error: 'no such interface' };
			const flt = a.filter ?? '';
			if (type(flt) != 'string' || length(flt) > 200 || !match(flt, /^[]A-Za-z0-9 .:\/()!&|=<>[_-]*$/) || substr(trim(flt), 0, 1) == '-')
				return { error: 'bad filter' };
			const secs = type(a.seconds) == 'int' && a.seconds >= 1 && a.seconds <= 300 ? a.seconds : 30;
			const n = type(a.packets) == 'int' && a.packets >= 1 && a.packets <= 200000 ? a.packets : 10000;
			unlink(CAP);
			// stop at the packet count (tcpdump), the time limit or 20 MB (this loop), whichever comes first
			const job = `tcpdump -i ${q(a.iface)} -n -s 0 -c ${n} -w ${CAP}${length(trim(flt)) ? ' ' + q(trim(flt)) : ''} >${CAP_LOG} 2>&1 & p=$!; ` +
				`echo $p >${CAP_PID}; t=0; while kill -0 $p 2>/dev/null; do ` +
				`[ $t -ge ${secs} ] && kill $p; [ "$(wc -c <${CAP} 2>/dev/null || echo 0)" -gt 20971520 ] && kill $p; sleep 1; t=$((t+1)); done`;
			system(`sh -c ${q(job)} </dev/null >/dev/null 2>&1 &`);
			return {};
		}
	},

	// -> {running, size (bytes), log (tcpdump's messages: "N packets captured", errors)}
	capture_status: {
		call: function() {
			return { running: !!cap_running(), size: stat(CAP)?.size ?? 0, log: trim(readfile(CAP_LOG) ?? '') };
		}
	},

	capture_stop: {
		call: function() {
			const pid = cap_running();
			if (pid) system(`kill ${pid}`);
			return {};
		}
	},

	// -> {installed, install?, enabled, running, version?, latest?, updating?, update_log?, backend?,
	//     auth_url?, tailnet?, self?, peers?, prefs?}
	// backend is tailscaled's BackendState: NeedsLogin, NeedsMachineAuth, Starting, Running, Stopped.
	// install: the download (er4.tailscale_install) {state: downloading|ok|error, message}.
	// latest: the newest release when this one is behind (tailscaled checks; null when current).
	tailscale_status: {
		call: function() {
			const install = ts_install_state();
			if (!access(TS)) return { installed: false, install };
			const running = sh('pidof tailscaled') != '';
			const j = pkg_job();
			const updating = !!(j?.running && j.feature == 'tailscale' && j.action == 'upgrade');
			const r = { installed: true, install, enabled: system('/etc/init.d/tailscale enabled') == 0, running,
				updating, update_log: updating ? j.log[length(j.log) - 1] ?? null : null };
			// the CLI is a 35 MB binary: only ask it when tailscaled can't say
			r.version = running ? null : split(sh(`${TS} version 2>/dev/null`), '\n')[0] || null;
			if (!running) return r;
			const st = ts_json('status --json');
			const vm = match(st?.Version ?? '', /^[0-9.]+/);
			r.version = vm ? vm[0] : null;
			const p = ts_json('debug prefs');
			if (!st) return r;
			const node = (n) => ({
				name: n.HostName, dns: replace(n.DNSName ?? '', /\.$/, ''), ips: n.TailscaleIPs ?? [], os: n.OS,
				online: !!n.Online, last_seen: n.LastSeen, exit_node: !!n.ExitNode, exit_option: !!n.ExitNodeOption,
				relay: n.Relay, direct: length(n.CurAddr ?? '') > 0, rx: n.RxBytes ?? 0, tx: n.TxBytes ?? 0,
				routes: filter(n.PrimaryRoutes ?? [], (x) => x != '0.0.0.0/0' && x != '::/0')
			});
			const peers = [];
			for (let k, n in st.Peer ?? {}) push(peers, node(n));
			return {
				...r, latest: pkg_upgradable('tailscale'),
				backend: st.BackendState, auth_url: st.AuthURL || null, tailnet: st.CurrentTailnet?.Name,
				health: st.Health ?? [], self: st.Self ? node(st.Self) : null, peers,
				prefs: p ? { routes: p.AdvertiseRoutes ?? [], exit_node: index(p.AdvertiseRoutes ?? [], '0.0.0.0/0') >= 0,
					accept_routes: !!p.RouteAll, use_exit_node: p.ExitNodeID || null, auto_update: p.AutoUpdate?.Apply === true } : null
			};
		}
	},

	// {} -> {} | {error}: install OpenWrt's tailscale package; progress in tailscale_status.install
	tailscale_install: {
		call: function() {
			return pkg_start('install', 'tailscale');
		}
	},

	// {} -> {} | {error}: upgrade the tailscale package (apk) and restart the service
	tailscale_update: {
		call: function() {
			if (!access(TS)) return { error: 'tailscale is not installed' };
			return pkg_start('upgrade', 'tailscale');
		}
	},

	// {routes: [cidr], exit_node: bool, accept_routes: bool} -> {} | {error}
	// Starts the service; logged in it applies the settings (tailscale set), otherwise it starts a
	// login in the background (tailscale up) and tailscale_status then carries the auth_url.
	tailscale_up: {
		args: { routes: [], exit_node: false, accept_routes: false },
		call: function(req) {
			if (!access(TS)) return { error: 'tailscale is not installed' };
			const routes = req.args.routes ?? [];
			if (type(routes) != 'array' || length(routes) > 32 || length(filter(routes, (c) => !cidr_ok(c)))) return { error: 'bad routes' };
			const flags = `--accept-dns=false --advertise-routes=${q(join(',', routes))} ` +
				`--advertise-exit-node=${req.args.exit_node ? 'true' : 'false'} --accept-routes=${req.args.accept_routes ? 'true' : 'false'}`;
			if (sh('pidof tailscaled') == '') {
				system('/etc/init.d/tailscale enable; /etc/init.d/tailscale start');
				// wait (≤ 5 s) for the daemon's socket
				for (let i = 0; i < 5 && !stat('/var/run/tailscale/tailscaled.sock'); i++) system('sleep 1');
			}
			const st = ts_json('status --json');
			if (st?.BackendState == 'Running') {
				const out = sh(`${TS} set ${flags} 2>&1`);
				return length(out) ? { error: out } : {};
			}
			system(`sh -c ${q(`${TS} up --reset ${flags} --timeout=600s`)} </dev/null >/tmp/er4-tailscale-up.log 2>&1 &`);
			return {};
		}
	},

	// {stop: bool} -> {}: log this router out of the tailnet; stop: also stop and disable the service
	tailscale_logout: {
		args: { stop: false },
		call: function(req) {
			if (!access(TS)) return { error: 'tailscale is not installed' };
			system(`${TS} logout >/dev/null 2>&1`);
			if (req.args.stop) system('/etc/init.d/tailscale stop; /etc/init.d/tailscale disable');
			return {};
		}
	},

	// -> {installed, running, sas: [{name, state, remote_host, remote_id, eap_id, vips, established, children: [...]}],
	//     ca: PEM text (clients install it), server: {subject, san, not_after}}
	ipsec_status: {
		call: function() {
			if (!access('/usr/sbin/swanctl')) return { installed: false };
			const running = sh('pidof charon') != '';
			const sas = [];
			if (running) {
				const tree = parse_pretty(sh('swanctl --list-sas --pretty 2>/dev/null'));
				for (let ev, body in tree) {
					if (!match(ev, /^list-sa event(#[0-9]+)?$/)) continue;
					for (let name, sa in body) {
						const children = [];
						for (let cn, c in sa['child-sas'] ?? {}) push(children, {
							name: c.name ?? cn, state: c.state, local_ts: c['local-ts'] ?? [], remote_ts: c['remote-ts'] ?? [],
							bytes_in: +(c['bytes-in'] ?? 0), bytes_out: +(c['bytes-out'] ?? 0), encr: c['encr-alg']
						});
						push(sas, {
							name, state: sa.state, remote_host: sa['remote-host'], remote_id: sa['remote-id'], eap_id: sa['remote-eap-id'],
							vips: sa['remote-vips'] ?? [], established: +(sa.established ?? 0), encr: sa['encr-alg'], dh: sa['dh-group'], children
						});
					}
				}
			}
			return {
				installed: true, running, sas,
				ca: readfile(`${SWAN}/x509ca/er4-ca.pem`),
				server: cert_info(`${SWAN}/x509/er4-server.pem`)
			};
		}
	},

	// {name} -> {} | {error}: the router's CA (made once) and a server certificate for `name`
	// (its public hostname or address, what clients connect to). ECDSA P-256.
	ipsec_cert: {
		args: { name: 'name' },
		call: function(req) {
			const n = req.args.name;
			if (!access('/usr/bin/pki') && !access('/usr/sbin/pki')) return { error: 'strongswan-pki is not installed' };
			if (type(n) != 'string' || !match(n, /^[A-Za-z0-9]([A-Za-z0-9.-]{0,252})$/)) return { error: 'a host name or IPv4 address' };
			const ca = `${SWAN}/x509ca/er4-ca.pem`, cakey = `${SWAN}/private/er4-ca.key`;
			const key = `${SWAN}/private/er4-server.key`, crt = `${SWAN}/x509/er4-server.pem`;
			system(`mkdir -p ${SWAN}/x509ca ${SWAN}/x509 ${SWAN}/private; chmod 700 ${SWAN}/private`);
			if (!access(ca) || !access(cakey)) {
				if (system(`pki --gen --type ecdsa --size 256 --outform pem >${cakey} && chmod 600 ${cakey} && ` +
					`pki --self --ca --lifetime 3650 --in ${cakey} --type ecdsa --dn "CN=ER-4 VPN CA" --outform pem >${ca}`) != 0)
					return { error: 'making the CA failed' };
			}
			const ip = match(n, /^[0-9.]+$/) != null;
			const rc = system(`pki --gen --type ecdsa --size 256 --outform pem >${key}.new && chmod 600 ${key}.new && ` +
				`pki --pub --in ${key}.new --type ecdsa | pki --issue --lifetime 1825 --cacert ${ca} --cakey ${cakey} ` +
				`--dn ${q('CN=' + n)} --san ${q(n)}${ip ? ' --san ' + q('@' + n) : ''} --flag serverAuth --flag ikeIntermediate --outform pem >${crt}.new && ` +
				`mv ${key}.new ${key} && mv ${crt}.new ${crt}`);
			if (rc != 0) { system(`rm -f ${key}.new ${crt}.new`); return { error: 'issuing the certificate failed' }; }
			system('/etc/init.d/swanctl enabled && /etc/init.d/swanctl reload >/dev/null 2>&1');
			return {};
		}
	},

	// -> {installed, config: {domain, host, email, token_set} | null, running, cert: {issuer, names,
	//     not_before, not_after, days} | null, serving, lan, log: [lines]}
	acme_status: {
		call: function() {
			if (!access(`${ACME}/acme.sh`) || !access(`${ACME}/dnsapi/dns_cf.sh`)) return { installed: false };
			const c = cursor();
			const names = acme_names();
			const cfg = c.get('acme', 'er4') == 'cert' ? {
				domain: names[0], host: c.get('acme', 'er4', 'er4_host'),
				email: c.get_first('acme', 'acme', 'account_email'),
				token_set: length(filter(c.get('acme', 'er4', 'credentials') ?? [], (x) => match(x, /^CF_Token=/))) > 0
			} : null;
			const crt = cfg ? `/etc/ssl/acme/${cfg.domain}.fullchain.crt` : null;
			return {
				installed: true, config: cfg, running: acme_running(),
				cert: crt ? x509_info(crt) : null,
				serving: crt != null && c.get('uhttpd', 'main', 'cert') == crt,
				lan: lan_addr(),
				log: filter(split(sh('logread -e "acme" 2>/dev/null | tail -n 40'), '\n'), length)
			};
		}
	},

	// {domain, host, email, token?} -> {} | {error}: save acme.er4 (token may be left out once
	// saved), the local DNS name, and start issuing. Progress: acme_status (running, log).
	acme_setup: {
		args: { domain: 'domain', host: 'host', email: 'email', token: 'token' },
		call: function(req) {
			const a = req.args;
			if (!access(`${ACME}/acme.sh`)) return { error: 'acme.sh is not installed' };
			if (type(a.domain) != 'string' || !match(a.domain, /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/)) return { error: 'a domain name like example.com' };
			if (type(a.host) != 'string' || !match(a.host, /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/)) return { error: 'a name like router' };
			if (type(a.email) != 'string' || !match(a.email, /^[^@\s"'`$\\]+@[^@\s"'`$\\]+\.[^@\s"'`$\\]+$/)) return { error: 'an email address' };
			// acme.init evals each credential: only token characters get through
			if (a.token != null && a.token != '' && (type(a.token) != 'string' || !match(a.token, /^[A-Za-z0-9_-]{20,128}$/))) return { error: "that doesn't look like a Cloudflare API token" };
			const lan = lan_addr();
			if (!lan) return { error: 'the LAN has no IPv4 address' };
			const c = cursor();
			let creds = c.get('acme', 'er4', 'credentials') ?? [];
			if (a.token) creds = [ `CF_Token="${a.token}"` ];
			if (!length(creds)) return { error: 'the Cloudflare API token is missing' };
			let g = null;
			c.foreach('acme', 'acme', (s) => { g ??= s['.name']; });
			g ??= c.add('acme', 'acme');
			c.set('acme', g, 'account_email', a.email);
			// only ours: the package's examples (and anything else) would be issued too
			const other = [];
			c.foreach('acme', 'cert', (s) => { if (s['.name'] != 'er4') push(other, s['.name']); });
			for (let n in other) c.delete('acme', n);
			c.set('acme', 'er4', 'cert');
			for (let k, v in { enabled: '1', staging: '0', validation_method: 'dns', dns: 'dns_cf', key_type: 'ec256',
				domains: [ a.domain, `*.${a.domain}` ], credentials: creds, er4_host: a.host })
				c.set('acme', 'er4', k, v);
			c.commit('acme');
			c.set('dhcp', 'er4_https', 'domain');
			c.set('dhcp', 'er4_https', 'name', `${a.host}.${a.domain}`);
			c.set('dhcp', 'er4_https', 'ip', lan);
			c.commit('dhcp');
			system('rm -rf /etc/acme/*.failed-*; /etc/init.d/dnsmasq reload >/dev/null 2>&1');
			// a certificate this domain already has is served now (renew skips it while it's valid);
			// uhttpd restarts after this reply is out
			system('/etc/init.d/acme enable; /etc/init.d/acme start >/dev/null 2>&1; /etc/init.d/acme renew >/dev/null 2>&1; ' +
				'(sleep 1; /usr/libexec/er4-https use) </dev/null >/dev/null 2>&1 &');
			return {};
		}
	},

	acme_renew: {
		call: function() {
			if (cursor().get('acme', 'er4') != 'cert') return { error: 'not set up' };
			system('/etc/init.d/acme renew >/dev/null 2>&1');
			return {};
		}
	},

	// -> {}: back to the self-signed certificate; the certificate, the saved token and the DNS
	// name go too
	acme_off: {
		call: function() {
			const c = cursor();
			const d = acme_names()[0];
			system('/etc/init.d/acme abort >/dev/null 2>&1');
			if (c.get('acme', 'er4')) { c.delete('acme', 'er4'); c.commit('acme'); }
			if (c.get('dhcp', 'er4_https')) { c.delete('dhcp', 'er4_https'); c.commit('dhcp'); }
			if (d) system(`rm -rf /etc/acme/${q(d)}_ecc /etc/acme/${q(d)}_ecc.* /etc/ssl/acme/${q(d)}.*`);
			system("sed -i '/^SAVED_CF_/d' /etc/acme/account.conf 2>/dev/null; /etc/init.d/dnsmasq reload >/dev/null 2>&1; " +
				'(sleep 1; /usr/libexec/er4-https off) </dev/null >/dev/null 2>&1 &');
			return {};
		}
	},

	// {tool: 'ping'|'traceroute'|'nslookup', host, family?: 4|6, count?, server?} -> {id}
	diag_start: {
		args: { tool: 'ping', host: 'host', family: 4, count: 5, server: 'server' },
		call: function(req) {
			const cmd = diag_cmd(req.args);
			if (!cmd) return { error: 'bad arguments' };
			if (diag_sweep() >= 3) return { error: 'too many tools running' };
			const id = sprintf('%x%x', time(), diag_seq++ % 4096);
			const f = `${DIAG}/${id}`;
			const job = `${cmd} >${f}.out 2>&1 & p=$!; echo $p >${f}.pid; ` +
				`(sleep ${DIAG_MAX_S}; kill $p) 2>/dev/null & w=$!; wait $p; rc=$?; kill $w 2>/dev/null; echo $rc >${f}.rc`;
			system(`sh -c ${q(job)} </dev/null >/dev/null 2>&1 &`);
			return { id };
		}
	},

	// {id} -> {output, done, code?}; output is the last 64 KB
	diag_poll: {
		args: { id: 'id' },
		call: function(req) {
			const id = req.args.id;
			if (!diag_id_ok(id) || !stat(`${DIAG}/${id}.pid`) && !stat(`${DIAG}/${id}.out`))
				return { error: 'no such job' };
			const out = readfile(`${DIAG}/${id}.out`) ?? '';
			const rc = readfile(`${DIAG}/${id}.rc`);
			return {
				output: length(out) > 65536 ? substr(out, -65536) : out,
				done: rc != null,
				code: rc != null ? +trim(rc) : null
			};
		}
	},

	diag_stop: {
		args: { id: 'id' },
		call: function(req) {
			const id = req.args.id;
			const pid = diag_id_ok(id) ? +trim(readfile(`${DIAG}/${id}.pid`) ?? '') : 0;
			if (type(pid) == 'int' && pid > 1) system(`kill ${pid} 2>/dev/null`);
			return {};
		}
	}
};

return { er4: methods };
