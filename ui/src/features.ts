// Features that need more work on stock OpenWrt, hidden until then:
//   firmware: the old image's boot-slot updates; on stock it becomes a sysupgrade flow
//   tailscale, ipsec, https: move onto OpenWrt's tailscale, strongswan and acme packages
export const FEATURES = { firmware: false, tailscale: false, ipsec: false, https: false }
