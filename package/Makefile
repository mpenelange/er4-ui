# SPDX-License-Identifier: GPL-2.0-only
# er4 web UI for stock OpenWrt: the app from ../ui (build it first: cd ui && npm ci && npm run build),
# served by uhttpd at /er4/ next to LuCI, plus the "er4" rpcd plugin and its ACL.
# rpcd-mod-luci (luci-rpc: leases, host hints) and cgi-io (uploads, backup download) are the LuCI
# backends it uses; LuCI itself isn't needed. wireguard-tools for the VPN page, tcpdump-mini for
# packet captures. Tailscale, strongSwan and acme.sh are installed on request from their pages
# (er4.pkg_install). files/er4-https and its acme hotplug point uhttpd at the issued certificate.
include $(TOPDIR)/rules.mk

PKG_NAME:=er4-ui
PKG_VERSION:=0.4.0
PKG_RELEASE:=1
PKG_LICENSE:=GPL-2.0-only

ER4_UI_DIST ?= $(CURDIR)/../ui/dist

include $(INCLUDE_DIR)/package.mk

define Package/er4-ui
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=er4 web UI
  DEPENDS:=+rpcd +rpcd-mod-ucode +rpcd-mod-luci +cgi-io +ucode-mod-fs +ucode-mod-uci \
    +uhttpd +uhttpd-mod-ubus +wireguard-tools +tcpdump-mini
  PKGARCH:=all
endef

define Package/er4-ui/description
  Dense single-page admin UI (Preact app at /er4/) and the rpcd plugin "er4" it reads live
  state from. Installs next to LuCI. Shows kmod-octeon-offload's state on the EdgeRouter 4.
endef

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
	[ -f $(ER4_UI_DIST)/index.html ] || { echo "$(ER4_UI_DIST) missing: cd ui && npm ci && npm run build"; false; }
	$(CP) $(ER4_UI_DIST) $(PKG_BUILD_DIR)/www
endef

define Build/Compile
endef

define Package/er4-ui/install
	$(INSTALL_DIR) $(1)/www/er4 $(1)/usr/share/rpcd/ucode $(1)/usr/share/rpcd/acl.d $(1)/usr/share/er4 \
		$(1)/usr/libexec $(1)/etc/init.d $(1)/etc/hotplug.d/iface
	$(CP) $(PKG_BUILD_DIR)/www/. $(1)/www/er4/
	$(INSTALL_DATA) ./files/er4.uc $(1)/usr/share/rpcd/ucode/er4
	$(INSTALL_DATA) ./files/er4.acl.json $(1)/usr/share/rpcd/acl.d/er4.json
	$(INSTALL_DATA) ./files/zoneinfo.json $(1)/usr/share/er4/zoneinfo.json
	$(INSTALL_BIN) ./files/er4-wanmon $(1)/usr/libexec/er4-wanmon
	$(INSTALL_BIN) ./files/er4-wanmon.init $(1)/etc/init.d/er4-wanmon
	$(INSTALL_BIN) ./files/er4-statsmon $(1)/usr/libexec/er4-statsmon
	$(INSTALL_BIN) ./files/er4-statsmon.init $(1)/etc/init.d/er4-statsmon
	$(INSTALL_DATA) ./files/90-er4-wan.hotplug $(1)/etc/hotplug.d/iface/90-er4-wan
	$(INSTALL_BIN) ./files/er4-https $(1)/usr/libexec/er4-https
	$(INSTALL_DIR) $(1)/etc/hotplug.d/acme
	$(INSTALL_DATA) ./files/90-er4-https.hotplug $(1)/etc/hotplug.d/acme/90-er4-https
endef

# rpcd loads plugins and ACLs when it starts: restart it so the "er4" object appears (or goes).
# That ends open LuCI sessions too, so LuCI asks for the password again.
define Package/er4-ui/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || /etc/init.d/rpcd restart
endef

define Package/er4-ui/postrm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || /etc/init.d/rpcd restart
endef

$(eval $(call BuildPackage,er4-ui))
