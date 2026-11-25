# er4-ui

A web UI for the Ubiquiti EdgeRouter 4 on stock OpenWrt, made to go with
[er4-openwrt-offload](https://github.com/mpenelange/er4-openwrt-offload). It installs next to
LuCI and is served at `/er4/`.

Dashboard, network, devices, DNS, firewall, VPN (WireGuard, Tailscale, IPsec), diagnostics, and
system pages including software (apk), firmware (sysupgrade) and backups. Optional features
install their OpenWrt packages when you set them up.

## Build

```sh
cd ui && npm ci && npm run build
```

Then, in an OpenWrt build tree or SDK for your release:

```sh
make -C /path/to/er4-ui/package TOPDIR=$PWD CONFIG_PACKAGE_er4-ui=m compile
```

## Install

```sh
apk add --allow-untrusted er4-ui-*.apk
```

`npm run dev` in `ui/` runs it against a mock router, no hardware needed.

GPL-2.0.
