#!/usr/bin/env bash
# Kōrero voice server quick deploy.
#
#   curl -fsSL https://raw.githubusercontent.com/WardPearce/korero/main/scripts/install.sh | sudo bash
#
# Asks for the important settings from backend/server.example.toml, writes the
# configuration and deploys the server with Docker Compose or as a systemd service
# running the standalone Linux binary. Run it again to update; it offers to keep the
# existing configuration. Data is never deleted.
#
# Options (pass after `bash -s --` when piping):
#   --docker | --binary   Choose the deploy method without asking.
#   --yes                 Accept every default (non-interactive).
#   --dry-run             Print the files that would be written, then exit.
#   --dir PATH            Docker project directory (default /opt/korero).
#   --version TAG         Release tag for the binary or image (default latest).
#   --help                Show this help.

set -euo pipefail

main() {
	readonly REPO="WardPearce/korero"
	readonly IMAGE="wardpearce/korero-server"
	readonly SERVICE_USER="korero"
	readonly DATA_DIR="/var/lib/korero"
	readonly BIN_PATH="/usr/local/bin/voice-server"
	readonly UNIT_PATH="/etc/systemd/system/korero.service"
	readonly CONTAINER_UID=10001

	SERVER_PORT=8443 MEDIA_PORT=8444 WORKERS=1 ENABLE_TCP=1 PUBLIC_ADDRESS="" PASSWORD=""
	METHOD="" ASSUME_YES=0 DRY_RUN=0 PROJECT_DIR="/opt/korero" VERSION="latest"
	while [[ $# -gt 0 ]]; do
		case "$1" in
			--docker) METHOD=docker ;;
			--binary) METHOD=binary ;;
			--yes | -y) ASSUME_YES=1 ;;
			--dry-run) DRY_RUN=1 ;;
			--dir) PROJECT_DIR="${2:?--dir needs a path}"; shift ;;
			--version) VERSION="${2:?--version needs a tag}"; shift ;;
			--help | -h) usage; exit 0 ;;
			*) die "Unknown option: $1" ;;
		esac
		shift
	done

	[[ "$(uname -s)" == Linux ]] || die "The Kōrero server runs on Linux only."
	if [[ $ASSUME_YES -eq 0 ]] && ! { : </dev/tty; } 2>/dev/null; then
		die "No terminal to ask questions on. Re-run with --yes to accept the defaults."
	fi
	[[ $DRY_RUN -eq 1 || $EUID -eq 0 ]] || die "Run as root, for example: curl -fsSL … | sudo bash"
	need curl

	banner

	if [[ -z "$METHOD" ]]; then
		local suggested=binary
		command -v docker >/dev/null 2>&1 && suggested=docker
		choose METHOD "How do you want to run the server?" "$suggested" docker binary
	fi

	local existing=""
	if [[ $METHOD == docker && -f "$PROJECT_DIR/compose.yaml" ]]; then existing="$PROJECT_DIR/compose.yaml"; fi
	if [[ $METHOD == binary && -f "$DATA_DIR/server.toml" ]]; then existing="$DATA_DIR/server.toml"; fi

	KEEP_CONFIG=0
	if [[ -n "$existing" ]]; then
		info "Found an existing configuration at $existing."
		confirm KEEP_CONFIG "Keep it and only update the server?" Y
	fi

	if [[ $KEEP_CONFIG -eq 0 ]]; then
		ask_settings
		build_toml
	fi

	if [[ $DRY_RUN -eq 1 ]]; then
		dry_run
		exit 0
	fi

	if [[ $METHOD == docker ]]; then deploy_docker; else deploy_binary; fi
	open_firewall
	show_startup
}

usage() {
	cat <<'USAGE'
Usage: install.sh [--docker | --binary] [--yes] [--dry-run] [--dir PATH] [--version TAG]

  --docker | --binary   Choose the deploy method without asking.
  --yes                 Accept every default (non-interactive). Set KORERO_PUBLIC_ADDRESS
                        and optionally KORERO_PASSWORD to answer those questions.
  --dry-run             Print the files that would be written, then exit.
  --dir PATH            Docker project directory (default /opt/korero).
  --version TAG         Release tag for the binary or image (default latest).
USAGE
}

# ---------------------------------------------------------------------------
# Output and prompts
# ---------------------------------------------------------------------------

if [[ -t 1 ]]; then
	BOLD=$'\e[1m' DIM=$'\e[2m' CYAN=$'\e[36m' YELLOW=$'\e[33m' RED=$'\e[31m' RESET=$'\e[0m'
else
	BOLD="" DIM="" CYAN="" YELLOW="" RED="" RESET=""
fi

banner() {
	printf '\n%sKōrero server quick deploy%s\n' "$BOLD" "$RESET"
	printf '%sPress Enter to accept the value in brackets.%s\n' "$DIM" "$RESET"
}
section() { printf '\n%s%s%s\n' "$BOLD$CYAN" "$1" "$RESET"; }
info() { printf '%s\n' "$*"; }
warn() { printf '%sWarning:%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
die() {
	printf '%sError:%s %s\n' "$RED" "$RESET" "$*" >&2
	exit 1
}
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required but not installed."; }

# ask VAR "Question" default [validator]
ask() {
	local __var=$1 __prompt=$2 __default=${3-} __validator=${4-} __reply
	while true; do
		if [[ $ASSUME_YES -eq 1 ]]; then
			__reply=$__default
		else
			printf '%s%s: ' "$__prompt" "${__default:+ [$__default]}" >/dev/tty
			IFS= read -r __reply </dev/tty || __reply=""
			__reply=${__reply:-$__default}
		fi
		if [[ -z "$__validator" ]] || "$__validator" "$__reply"; then
			printf -v "$__var" '%s' "$__reply"
			return 0
		fi
		if [[ $ASSUME_YES -eq 1 ]]; then die "No valid default for \"$__prompt\"."; fi
	done
}

ask_secret() {
	local __var=$1 __prompt=$2 __reply=${KORERO_PASSWORD-}
	while true; do
		if [[ $ASSUME_YES -eq 0 ]]; then
			printf '%s: ' "$__prompt" >/dev/tty
			IFS= read -rs __reply </dev/tty || __reply=""
			printf '\n' >/dev/tty
		fi
		if [[ ${#__reply} -gt 128 ]]; then
			warn "Passwords can be at most 128 characters."
		elif [[ $METHOD == docker && "$__reply" == *"'"* ]]; then
			warn "With Docker, the password cannot contain a single quote."
		else
			break
		fi
		if [[ $ASSUME_YES -eq 1 ]]; then die "KORERO_PASSWORD is not valid."; fi
	done
	printf -v "$__var" '%s' "$__reply"
}

# choose VAR "Question" default option...
choose() {
	local __choice=$1 __question=$2 __fallback=$3
	shift 3
	local __options=("$@") __joined
	__joined=$(
		IFS=/
		echo "${__options[*]}"
	)
	_one_of() {
		local o
		for o in "${__options[@]}"; do [[ "$1" == "$o" ]] && return 0; done
		warn "Choose one of: $__joined"
		return 1
	}
	ask "$__choice" "$__question ($__joined)" "$__fallback" _one_of
}

# confirm VAR "Question" Y|N  -> VAR=1 or 0
confirm() {
	local __flag=$1 __question=$2 __fallback=$3 __yn
	_yes_no() {
		[[ "$1" =~ ^([yY]([eE][sS])?|[nN][oO]?)$ ]] && return 0
		warn "Answer y or n."
		return 1
	}
	ask __yn "$__question (y/n)" "$__fallback" _yes_no
	if [[ "$__yn" =~ ^[yY] ]]; then printf -v "$__flag" 1; else printf -v "$__flag" 0; fi
}

# ask_int VAR "Question" default min max
ask_int() {
	INT_MIN=$4 INT_MAX=$5
	ask "$1" "$2" "$3" _int_in_range
}
_int_in_range() {
	if [[ "$1" =~ ^[0-9]+$ ]] && ((10#$1 >= INT_MIN && 10#$1 <= INT_MAX)); then return 0; fi
	warn "Enter a whole number from $INT_MIN to $INT_MAX."
	return 1
}

# ---------------------------------------------------------------------------
# Validators
# ---------------------------------------------------------------------------

_server_name() {
	if [[ -n "${1// /}" && ${#1} -le 100 && ! "$1" =~ [[:cntrl:]] ]]; then return 0; fi
	warn "Use 1-100 characters, not only spaces."
	return 1
}
_address() {
	# An IP literal or DNS name, without a scheme or port.
	if [[ "$1" =~ ^[A-Za-z0-9.-]+$ && "$1" == *[A-Za-z0-9] ]] || [[ "$1" =~ ^[0-9A-Fa-f:.]+$ && "$1" == *:* ]]; then
		return 0
	fi
	warn "Enter an IP address or hostname, without https:// or a port."
	return 1
}
_optional_ipv6() {
	[[ -z "$1" || ("$1" =~ ^[0-9A-Fa-f:.]+$ && "$1" == *:*) ]] && return 0
	warn "Enter an IPv6 address, or leave it empty."
	return 1
}
_ip_list() {
	local item
	IFS=',' read -ra _items <<<"$1"
	[[ ${#_items[@]} -gt 0 ]] || { warn "Enter at least one IP address."; return 1; }
	for item in "${_items[@]}"; do
		item=${item// /}
		[[ "$item" =~ ^[0-9A-Fa-f:.]+$ && "$item" != "::" && "$item" != "0.0.0.0" ]] || {
			warn "\"$item\" is not an exact IP address."
			return 1
		}
	done
}
_readable_file() {
	[[ -f "$1" && -r "$1" ]] && return 0
	warn "Cannot read $1."
	return 1
}

# ---------------------------------------------------------------------------
# Questions
# ---------------------------------------------------------------------------

detect_ip() {
	# Reads the local routing table; no traffic leaves the machine.
	local ip
	ip=$(ip -4 route get 192.0.2.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n1) || true
	[[ -n "$ip" ]] || ip=$(hostname -I 2>/dev/null | awk '{print $1}') || true
	echo "${ip:-203.0.113.10}"
}

ask_settings() {
	section "Server"
	ask NAME "Server name, shown to everyone who connects" "Kōrero" _server_name

	section "Network"
	local local_ip reach
	local_ip=$(detect_ip)
	choose reach "Will people connect over the internet, or only on this network?" internet internet lan
	if [[ $reach == internet ]]; then
		info "${DIM}Use your public IP or a DNS name pointing at it. Ports must be forwarded if the host is behind NAT.${RESET}"
		ask PUBLIC_ADDRESS "Public IP or hostname" "${KORERO_PUBLIC_ADDRESS-}" _address
		ANNOUNCED="$PUBLIC_ADDRESS"
	else
		ask PUBLIC_ADDRESS "Address people on your network use for this machine" "${KORERO_PUBLIC_ADDRESS:-$local_ip}" _address
		# The binary discovers LAN addresses itself; a container only sees its own.
		if [[ $METHOD == docker ]]; then ANNOUNCED="$PUBLIC_ADDRESS"; else ANNOUNCED=""; fi
	fi

	section "Accounts"
	info "${DIM}open: anyone · invitation: anyone with an invite · admin: invites from admins only · disabled: no new accounts${RESET}"
	choose REGISTRATION "Who can create accounts?" invitation open invitation admin disabled
	info "${DIM}Optional. Everyone without an invitation must enter it to sign in or register.${RESET}"
	ask_secret PASSWORD "Shared server password (leave empty for none)"
	ask_int MAX_USERS "Maximum people online at once" 128 1 10000
	info "${DIM}Hosted accounts let people keep an encrypted Kōrero account on this server and use it elsewhere.${RESET}"
	choose ACCOUNT_HOST "Allow new hosted accounts?" closed open closed

	section "Voice and chat"
	ask_int BITRATE_KBPS "Voice quality in kbit/s" 64 32 128
	confirm PERSISTENCE "Keep chat history on the server?" Y
	RETENTION_DAYS=7
	if [[ $PERSISTENCE -eq 1 ]]; then ask_int RETENTION_DAYS "Days to keep chat history" 7 1 365; fi

	# Advanced defaults.
	SERVER_PORT=8443 MEDIA_PORT=8444 WORKERS=1 ENABLE_TCP=1 ANNOUNCED_IPV6="" TLS_MODE=self-signed
	TLS_CERT="" TLS_KEY="" TRUSTED_PROXIES=""
	local advanced
	confirm advanced "Change advanced settings (ports, media workers, IPv6, TLS)?" N
	if [[ $advanced -eq 1 ]]; then ask_advanced; fi
}

ask_advanced() {
	section "Advanced"
	while true; do
		ask_int SERVER_PORT "HTTPS and WebSocket port (TCP)" "$SERVER_PORT" 1 65535
		ask_int WORKERS "Media workers (one per CPU core you want to use for voice)" "$WORKERS" 1 32
		ask_int MEDIA_PORT "First media port (uses $WORKERS consecutive ports)" "$MEDIA_PORT" 1 $((65536 - WORKERS))
		confirm ENABLE_TCP "Offer media over TCP as a fallback for strict networks?" Y
		if [[ $ENABLE_TCP -eq 1 ]] && ((SERVER_PORT >= MEDIA_PORT && SERVER_PORT < MEDIA_PORT + WORKERS)); then
			warn "The HTTPS port overlaps the media ports. Pick different ports."
			continue
		fi
		break
	done
	if [[ -n "$ANNOUNCED" ]]; then
		ask ANNOUNCED_IPV6 "Public IPv6 address for media (leave empty to skip)" "" _optional_ipv6
	fi

	info "${DIM}self-signed: no domain needed, apps pin the key · manual: your own certificate · proxy: a reverse proxy handles TLS${RESET}"
	choose TLS_MODE "How should the server get its certificate?" self-signed self-signed manual proxy
	case $TLS_MODE in
		manual)
			ask TLS_CERT "Path to the PEM certificate chain" "" _readable_file
			ask TLS_KEY "Path to the PEM private key" "" _readable_file
			;;
		proxy)
			info "${DIM}Keep the server on a private interface and forward WebSocket upgrades. Media still goes direct.${RESET}"
			ask TRUSTED_PROXIES "Exact IP addresses of your reverse proxies, comma separated" "" _ip_list
			;;
	esac
}

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

toml_str() {
	local s=${1//\\/\\\\}
	s=${s//\"/\\\"}
	printf '"%s"' "$s"
}
toml_list() {
	local out="" item
	IFS=',' read -ra _items <<<"$1"
	for item in "${_items[@]}"; do
		item=${item// /}
		[[ -n "$item" ]] && out+="${out:+, }$(toml_str "$item")"
	done
	printf '[%s]' "$out"
}

# Paths the server reads its manual certificate from.
cert_paths() {
	if [[ $METHOD == docker ]]; then
		CERT_TARGET=/data/tls/certificate.pem KEY_TARGET=/data/tls/private-key.pem
		CERT_HOST="$PROJECT_DIR/tls/certificate.pem" KEY_HOST="$PROJECT_DIR/tls/private-key.pem"
	else
		CERT_TARGET=/etc/korero/tls/certificate.pem KEY_TARGET=/etc/korero/tls/private-key.pem
		CERT_HOST=$CERT_TARGET KEY_HOST=$KEY_TARGET
	fi
}

# No blank lines: Docker passes this inline through VOICE_CONFIG.
build_toml() {
	cert_paths
	TOML="# Generated by the Kōrero quick deploy script on $(date -u +%Y-%m-%d).
# See https://github.com/$REPO/blob/main/backend/server.example.toml for every setting.
[server]
name = $(toml_str "$NAME")
port = $SERVER_PORT
registration = \"$REGISTRATION\"
max_users = $MAX_USERS
public_addresses = $(toml_list "$PUBLIC_ADDRESS")"
	[[ $TLS_MODE == proxy ]] && TOML+="
trusted_proxies = $(toml_list "$TRUSTED_PROXIES")"
	# Docker keeps the password in .env instead of the compose file.
	[[ $METHOD == binary ]] && TOML+="
password = $(toml_str "$PASSWORD")"
	TOML+="
[remote-account-host]
registration = \"$ACCOUNT_HOST\"
[tls]
mode = \"$TLS_MODE\""
	[[ $TLS_MODE == manual ]] && TOML+="
certificate = $(toml_str "$CERT_TARGET")
private_key = $(toml_str "$KEY_TARGET")"
	TOML+="
[media]
announced_address = $(toml_str "$ANNOUNCED")
announced_ipv6 = $(toml_str "$ANNOUNCED_IPV6")
port = $MEDIA_PORT
workers = $WORKERS
target_audio_bitrate = $((BITRATE_KBPS * 1000))
enable_tcp = $([[ $ENABLE_TCP -eq 1 ]] && echo true || echo false)
[messaging]
persistence = $([[ $PERSISTENCE -eq 1 ]] && echo true || echo false)
retention_hours = $((RETENTION_DAYS * 24))"
}

port_range() {
	if ((WORKERS > 1)); then echo "$MEDIA_PORT-$((MEDIA_PORT + WORKERS - 1))"; else echo "$MEDIA_PORT"; fi
}

compose_yaml() {
	local media
	media=$(port_range)
	printf '%s\n' "# Generated by the Kōrero quick deploy script. Re-run it to change settings,
# or edit VOICE_CONFIG below and run: docker compose up -d
services:
  voice-server:
    image: $IMAGE:$VERSION
    restart: unless-stopped
    ports:
      - \"$SERVER_PORT:$SERVER_PORT/tcp\"
      - \"$media:$media/udp\""
	if [[ $ENABLE_TCP -eq 1 ]]; then printf '      - "%s:%s/tcp"\n' "$media" "$media"; fi
	printf '%s\n' "    volumes:
      - voice-data:/data"
	if [[ $TLS_MODE == manual ]]; then printf '      - ./tls:/data/tls:ro\n'; fi
	if [[ -n "$PASSWORD" ]]; then printf '    env_file: .env\n'; fi
	printf '%s\n' "    environment:
      VOICE_DATA_DIR: /data
      # Also read by the container health check.
      VOICE_SERVER_PORT: \"$SERVER_PORT\"
      VOICE_CONFIG: |"
	# Compose interpolates $, so double it.
	printf '%s\n' "${TOML//\$/\$\$}" | sed 's/^/        /'
	printf '%s\n' "volumes:
  voice-data:"
}

systemd_unit() {
	printf '%s\n' "[Unit]
Description=Kōrero voice server
After=network-online.target
Wants=network-online.target

[Service]
User=$SERVICE_USER
ExecStart=$BIN_PATH --data-dir $DATA_DIR
Restart=on-failure
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target"
}

dry_run() {
	section "Dry run: nothing was changed"
	if [[ $KEEP_CONFIG -eq 1 ]]; then
		info "The existing configuration would be kept and the server updated."
		return
	fi
	if [[ $METHOD == docker ]]; then
		printf '\n%s# %s/compose.yaml%s\n' "$DIM" "$PROJECT_DIR" "$RESET"
		compose_yaml
		if [[ -n "$PASSWORD" ]]; then printf '\n%s# %s/.env (mode 600)%s\nVOICE_SERVER_PASSWORD=<hidden>\n' "$DIM" "$PROJECT_DIR" "$RESET"; fi
	else
		printf '\n%s# %s/server.toml%s\n' "$DIM" "$DATA_DIR" "$RESET"
		printf '%s\n' "$TOML" | sed 's/^password = .*/password = "<hidden>"/'
		printf '\n%s# %s%s\n' "$DIM" "$UNIT_PATH" "$RESET"
		systemd_unit
	fi
}

# ---------------------------------------------------------------------------
# Deploy
# ---------------------------------------------------------------------------

deploy_docker() {
	section "Deploying with Docker"
	if ! command -v docker >/dev/null 2>&1; then
		local install_docker
		confirm install_docker "Docker is not installed. Install it with Docker's official script (get.docker.com)?" Y
		[[ $install_docker -eq 1 ]] || die "Install Docker, then run this script again."
		curl -fsSL https://get.docker.com | sh
	fi
	docker compose version >/dev/null 2>&1 || die "The Docker Compose plugin is required (docker compose)."

	install -d -m 0755 "$PROJECT_DIR"
	cd "$PROJECT_DIR"

	if [[ $KEEP_CONFIG -eq 0 ]]; then
		if [[ $TLS_MODE == manual ]]; then
			# The server only reads a key owned by its own user with mode 600.
			install -d -m 0750 -o "$CONTAINER_UID" -g "$CONTAINER_UID" tls
			install -m 0644 -o "$CONTAINER_UID" -g "$CONTAINER_UID" "$TLS_CERT" "$CERT_HOST"
			install -m 0600 -o "$CONTAINER_UID" -g "$CONTAINER_UID" "$TLS_KEY" "$KEY_HOST"
			warn "The certificate was copied to $PROJECT_DIR/tls. Copy it again when it renews."
		fi
		backup_file compose.yaml
		(umask 077 && compose_yaml >compose.yaml.new) && mv compose.yaml.new compose.yaml
		if [[ -n "$PASSWORD" ]]; then
			# Single-quoted .env values are taken literally.
			(umask 077 && printf "VOICE_SERVER_PASSWORD='%s'\n" "$PASSWORD" >.env)
		else
			rm -f .env
		fi
	fi

	info "Pulling the image…"
	docker compose pull --quiet
	info "Validating the configuration…"
	docker compose run --rm --no-deps voice-server config validate
	docker compose up -d
}

deploy_binary() {
	section "Deploying the binary"
	need sha256sum
	need systemctl
	local arch
	case "$(uname -m)" in
		x86_64 | amd64) arch=amd64 ;;
		aarch64 | arm64) arch=arm64 ;;
		*) die "No release binary for $(uname -m). Use Docker or build from source." ;;
	esac

	local base asset
	if [[ $VERSION == latest ]]; then
		base="https://github.com/$REPO/releases/latest/download"
	else
		base="https://github.com/$REPO/releases/download/$VERSION"
	fi
	asset="voice-server-linux-$arch"
	tmp=$(mktemp -d)
	trap 'rm -rf "$tmp"' EXIT
	chmod 0755 "$tmp" # The service user runs the downloaded binary to validate.

	info "Downloading $asset…"
	curl -fL --proto '=https' --tlsv1.2 --progress-bar -o "$tmp/$asset" "$base/$asset"
	curl -fsSL --proto '=https' --tlsv1.2 -o "$tmp/SHA256SUMS" "$base/SHA256SUMS"
	(cd "$tmp" && grep " $asset\$" SHA256SUMS | sha256sum -c --quiet -) || die "Checksum verification failed."
	chmod 0755 "$tmp/$asset"
	"$tmp/$asset" --version >/dev/null 2>&1 ||
		die "The binary does not run here. It needs glibc, libstdc++ and OpenSSL 3.5.9 or newer; try --docker instead."

	if ! id "$SERVICE_USER" >/dev/null 2>&1; then
		useradd --system --home "$DATA_DIR" --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
	fi
	install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR"

	local was_running=0
	systemctl is-active --quiet korero 2>/dev/null && was_running=1

	if [[ $KEEP_CONFIG -eq 0 ]]; then
		if [[ $TLS_MODE == manual ]]; then
			install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" /etc/korero/tls
			install -m 0644 -o "$SERVICE_USER" -g "$SERVICE_USER" "$TLS_CERT" "$CERT_HOST"
			install -m 0600 -o "$SERVICE_USER" -g "$SERVICE_USER" "$TLS_KEY" "$KEY_HOST"
			warn "The certificate was copied to /etc/korero/tls. Copy it again when it renews."
		fi
		local new="$DATA_DIR/server.toml.new"
		(umask 077 && printf '%s\n' "$TOML" >"$new")
		chown "$SERVICE_USER:$SERVICE_USER" "$new"
		info "Validating the configuration…"
		(cd / && runuser -u "$SERVICE_USER" -- "$tmp/$asset" --config "$new" config validate) || {
			rm -f "$new"
			die "The configuration is not valid."
		}
		backup_file "$DATA_DIR/server.toml"
		mv "$new" "$DATA_DIR/server.toml"
	fi

	if [[ $was_running -eq 1 ]]; then systemctl stop korero; fi
	install -m 0755 "$tmp/$asset" "$BIN_PATH"
	systemd_unit >"$UNIT_PATH"
	systemctl daemon-reload
	systemctl enable korero >/dev/null 2>&1
	systemctl start korero
}

backup_file() {
	[[ -f "$1" ]] || return 0
	cp -p "$1" "$1.$(date +%Y%m%d%H%M%S).bak"
	info "Saved the previous file as $1.*.bak"
}

open_firewall() {
	[[ $KEEP_CONFIG -eq 1 ]] && return 0
	local media tool="" answer
	media=$(port_range)
	if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
		tool=ufw
	elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
		tool=firewalld
	fi
	if [[ -z "$tool" ]]; then
		info "Open TCP $SERVER_PORT, UDP $media$([[ $ENABLE_TCP -eq 1 ]] && echo " and TCP $media") on any firewall in front of this host."
		return 0
	fi
	confirm answer "Open the server ports in $tool?" Y
	[[ $answer -eq 1 ]] || return 0
	if [[ $tool == ufw ]]; then
		ufw allow "$SERVER_PORT/tcp" >/dev/null
		ufw allow "${media/-/:}/udp" >/dev/null
		if [[ $ENABLE_TCP -eq 1 ]]; then ufw allow "${media/-/:}/tcp" >/dev/null; fi
	else
		firewall-cmd --permanent --add-port="$SERVER_PORT/tcp" >/dev/null
		firewall-cmd --permanent --add-port="$media/udp" >/dev/null
		if [[ $ENABLE_TCP -eq 1 ]]; then firewall-cmd --permanent --add-port="$media/tcp" >/dev/null; fi
		firewall-cmd --reload >/dev/null
	fi
	info "Opened the ports in $tool. Forward them on your router too if the host is behind NAT."
}

logs() {
	if [[ $METHOD == docker ]]; then
		docker compose --project-directory "$PROJECT_DIR" logs --no-log-prefix voice-server 2>/dev/null
	else
		journalctl -u korero --no-pager -o cat --since "-10min" 2>/dev/null
	fi
}

show_startup() {
	section "Starting"
	local i out=""
	for ((i = 0; i < 60; i++)); do
		out=$(logs || true)
		[[ "$out" == *"Server ID"* ]] && break
		sleep 1
	done
	if [[ "$out" != *"Server ID"* ]]; then
		warn "The server has not reported that it started. Check the logs:"
		if [[ $METHOD == docker ]]; then info "  cd $PROJECT_DIR && docker compose logs voice-server"; else info "  journalctl -u korero"; fi
		exit 1
	fi
	# Print the most recent startup summary.
	printf '%s\n' "$out" | awk '/ v[0-9]/ { block = "" } { block = block $0 "\n" } END { printf "%s", block }' | sed -n '1,/Remote accounts/p'

	section "Next steps"
	info "1. Open Kōrero, choose ${BOLD}Connect to server${RESET} and enter ${BOLD}${PUBLIC_ADDRESS:-the Public address}${RESET}$([[ ${SERVER_PORT:-8443} -ne 8443 ]] && echo ":$SERVER_PORT")."
	info "2. Check the fingerprint matches the one above, then enter the setup token to become the owner."
	info "   The token expires in 15 minutes. If it does, issue a new one:"
	if [[ $METHOD == docker ]]; then
		info "   cd $PROJECT_DIR && docker compose stop voice-server && docker compose run --rm --no-deps voice-server admin setup-token --yes && docker compose up -d"
	else
		info "   systemctl stop korero && runuser -u $SERVICE_USER -- voice-server --data-dir $DATA_DIR admin setup-token --yes && systemctl start korero"
	fi
	info "3. Run this script again at any time to update the server or change settings."
}

main "$@"
