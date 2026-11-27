<script lang="ts">
	import SiteHeader from '#lib/components/SiteHeader.svelte';
	import CodeBlock from '#lib/components/CodeBlock.svelte';
	import SiteFooter from '#lib/components/SiteFooter.svelte';

	const toc = [
		{ id: 'before', label: 'Before you start' },
		{ id: 'docker', label: 'Deploy with Docker' },
		{ id: 'binary', label: 'Deploy the binary' },
		{ id: 'first-owner', label: 'Claim the server' },
		{ id: 'configure', label: 'Configure' },
		{ id: 'tls', label: 'TLS and proxies' },
		{ id: 'backup', label: 'Back up and restore' },
		{ id: 'build', label: 'Build from source' }
	];

	const ports = [
		['8443', 'TCP', 'HTTPS and secure WebSocket'],
		['8444', 'UDP', 'WebRTC media'],
		['8444', 'TCP', 'WebRTC media fallback']
	];
</script>

<svelte:head>
	<title>Host a Kōrero server: Docker and binary</title>
	<meta
		name="description"
		content="Run a Kōrero voice server with Docker Compose or the standalone Linux binary, then claim it, configure it and back it up."
	/>
</svelte:head>

<SiteHeader />

<div class="mx-auto grid max-w-6xl gap-12 px-6 py-16 lg:grid-cols-[14rem_minmax(0,1fr)]">
	<nav aria-label="On this page" class="lg:sticky lg:top-6 lg:self-start">
		<p class="mb-3 text-sm font-semibold">On this page</p>
		<ul class="grid gap-1 border-l border-border text-sm">
			{#each toc as t (t.id)}
				<li>
					<a
						href="#{t.id}"
						class="-ml-px block border-l border-transparent py-1 pl-4 text-muted-foreground hover:border-primary hover:text-foreground"
					>
						{t.label}
					</a>
				</li>
			{/each}
		</ul>
	</nav>

	<main id="main" class="docs max-w-[44rem] min-w-0">
		<h1 class="text-4xl sm:text-5xl">Host a server</h1>
		<p class="lead">
			Run the server in a container or as a single Linux binary. Both use the same configuration and
			keep their state in one data directory.
		</p>

		<h2 id="before">Before you start</h2>
		<p>
			You need a Linux machine that clients can reach, with a local filesystem (SQLite needs file
			locking) and permission to run executables. Run one server per data directory, under its own
			system user.
		</p>
		<p>Open these ports on the host firewall, and forward them if the host is behind NAT:</p>
		<table>
			<thead><tr><th>Port</th><th>Protocol</th><th>Purpose</th></tr></thead>
			<tbody>
				{#each ports as [port, proto, purpose] (port + proto)}
					<tr><td><code>{port}</code></td><td>{proto}</td><td>{purpose}</td></tr>
				{/each}
			</tbody>
		</table>
		<p>
			Each extra media worker uses the next consecutive port. Clients on the internet need a public
			address for media. Set it with <code>media.announced_address</code>, or the
			<code>VOICE_MEDIA_ANNOUNCED_ADDRESS</code> variable in Docker.
		</p>

		<h2 id="docker">Deploy with Docker</h2>
		<p>
			The image supports AMD64 and ARM64. Start with a <code>server.toml</code> next to your compose
			file. Every setting is optional, so this one only sets the server name and the public
			addresses clients use for signalling and media. See
			<a href="#configure">Configure</a> for the rest.
		</p>
		<CodeBlock
			lang="toml"
			label="server.toml"
			code={`[server]
name = "My Kōrero server"
registration = "invitation"
# The public IP or hostname clients use for HTTPS/WSS.
public_addresses = ["203.0.113.10"]

[media]
# The public IP or hostname clients can reach the media port on.
announced_address = "203.0.113.10"`}
		/>
		<p>
			Then create a <code>compose.yaml</code> that mounts the file read-only and points
			<code>VOICE_CONFIG</code> at it.
		</p>
		<CodeBlock
			lang="yaml"
			label="compose.yaml"
			code={`services:
  voice-server:
    image: wardpearce/korero-server:latest
    restart: unless-stopped
    ports:
      - "8443:8443/tcp"
      - "8444:8444/udp"
      - "8444:8444/tcp"
    volumes:
      - voice-data:/data
      - ./server.toml:/config/server.toml:ro
    environment:
      VOICE_DATA_DIR: /data
      VOICE_CONFIG: /config/server.toml
volumes:
  voice-data:`}
		/>
		<p>
			The container runs as UID 10001, so the file must be readable by that user. Run
			<code>chmod 644 server.toml</code> if it isn't. Edit the file and run
			<code>docker compose restart</code> to apply changes.
		</p>
		<p>Start the server and read the log for the endpoint, fingerprint and setup token.</p>
		<CodeBlock
			lang="bash"
			code={`docker compose up -d
docker compose logs voice-server`}
		/>
		<p>
			The named volume keeps the database and TLS identity. The container runs as UID and GID 10001.
			If you use a bind mount instead, make that user the owner of the directory first. For IPv6,
			enable it on the host and the Docker network, and set
			<code>media.announced_ipv6</code> in <code>server.toml</code>.
		</p>
		<p>
			If the setup token expires before you claim the server, stop it, create a new token and start
			it again.
		</p>
		<CodeBlock
			lang="bash"
			code={`docker compose stop voice-server
docker compose run --rm --no-deps voice-server admin setup-token --yes
docker compose up -d`}
		/>
		<p>
			To build the image yourself, clone the repository and run
			<code>docker compose up -d --build</code> from its root.
		</p>

		<h2 id="binary">Deploy the binary</h2>
		<p>
			Each release attaches standalone Linux AMD64 and ARM64 executables and a
			<code>SHA256SUMS</code> file. The binary embeds its runtime and media worker. The host needs glibc,
			libstdc++ and OpenSSL 3.5.9 or newer shared libraries.
		</p>
		<ol>
			<li>
				Download the binary for your architecture and <code>SHA256SUMS</code> from the
				<a
					href="https://github.com/WardPearce/korero/releases"
					target="_blank"
					rel="noopener noreferrer"
				>
					latest release
				</a>.
			</li>
			<li>
				Verify and make it executable.
				<CodeBlock
					lang="bash"
					code={`sha256sum --ignore-missing -c SHA256SUMS
chmod +x voice-server-linux-amd64`}
				/>
			</li>
			<li>
				Create a dedicated user and data directory.
				<CodeBlock
					lang="bash"
					code={`sudo useradd --system --home /var/lib/korero --create-home korero
sudo install -m 0755 voice-server-linux-amd64 /usr/local/bin/voice-server`}
				/>
			</li>
			<li>
				Run it. On first start it creates the data directory, a Lobby channel, a TLS identity and a
				setup token.
				<CodeBlock lang="bash" code={`sudo -u korero voice-server --data-dir /var/lib/korero`} />
			</li>
		</ol>
		<p>
			To keep it running, add a systemd unit at <code>/etc/systemd/system/korero.service</code>.
		</p>
		<CodeBlock
			lang="ini"
			code={`[Unit]
Description=Kōrero voice server
After=network-online.target
Wants=network-online.target

[Service]
User=korero
ExecStart=/usr/local/bin/voice-server --data-dir /var/lib/korero
Restart=on-failure
Environment=VOICE_MEDIA_ANNOUNCED_ADDRESS=203.0.113.10

[Install]
WantedBy=multi-user.target`}
		/>
		<CodeBlock
			lang="bash"
			code={`sudo systemctl daemon-reload
sudo systemctl enable --now korero
journalctl -u korero`}
		/>

		<h2 id="first-owner">Claim the server</h2>
		<p>
			The first start prints the local signalling address (for example
			<code>192.168.1.100:8443</code>), the TLS public-key fingerprint and a one-time setup token.
			If you set <code>server.public_addresses</code>, it also prints a <code>Public</code>
			endpoint — share that one with remote clients. The token lasts 15 minutes by default. Treat the
			logs as sensitive until you have used it.
		</p>
		<ol>
			<li>Open Kōrero and choose <strong>Connect to server</strong>.</li>
			<li>
				Enter the address (the <code>Public</code> one if configured) and compare the fingerprint with
				the one in the log.
			</li>
			<li>Enter the setup token to create the first owner.</li>
		</ol>
		<p>
			Share the address and fingerprint with other people over a channel you trust. Their app checks
			the fingerprint before sending any credentials.
		</p>

		<h2 id="configure">Configure</h2>
		<p>
			Every setting is optional. Copy
			<a
				href="https://github.com/WardPearce/korero/blob/main/backend/server.example.toml"
				target="_blank"
				rel="noopener noreferrer"
			>
				server.example.toml
			</a>
			to <code>server.toml</code> in the data directory and edit it. Restart to apply changes.
		</p>
		<p>
			Any setting can also be an environment variable named <code>
				VOICE_&lt;SECTION&gt;_&lt;KEY&gt;
			</code>, such as <code>VOICE_SERVER_PORT</code>. Environment variables win over the file.
			Check a file before you restart.
		</p>
		<CodeBlock lang="bash" code={`voice-server --config ./server.toml config validate`} />
		<p>Settings most servers change first:</p>
		<table>
			<thead><tr><th>Setting</th><th>What it does</th></tr></thead>
			<tbody>
				<tr><td><code>server.name</code></td><td>The name clients display.</td></tr>
				<tr>
					<td><code>server.registration</code></td>
					<td>
						Who can create accounts: <code>open</code>, <code>invitation</code>, <code>admin</code>
						or <code>disabled</code>.
					</td>
				</tr>
				<tr><td><code>server.password</code></td><td>A shared password for new sign-ins.</td></tr>
				<tr>
					<td><code>server.public_addresses</code></td>
					<td>The public IP or hostname clients use for signalling; also added to TLS SANs.</td>
				</tr>
				<tr>
					<td><code>media.announced_address</code></td>
					<td>The public IP or hostname in media candidates.</td>
				</tr>
				<tr>
					<td><code>messaging.persistence</code></td>
					<td>Keep message history for one week. On by default.</td>
				</tr>
				<tr>
					<td><code>media.target_audio_bitrate</code></td>
					<td>Voice quality, from 32 to 128 kbit/s.</td>
				</tr>
			</tbody>
		</table>

		<h2 id="tls">TLS and proxies</h2>
		<p>
			The server always uses HTTPS. Choose how it gets its certificate with <code>tls.mode</code>.
		</p>
		<ul>
			<li>
				<code>self-signed</code> is the default. The server generates and renews a certificate, and clients
				pin its public key.
			</li>
			<li>
				<code>manual</code> loads your PEM files from <code>tls.certificate</code> and
				<code>tls.private_key</code>. The key must be readable only by the server user.
			</li>
			<li>
				<code>proxy</code> lets a reverse proxy terminate TLS. List its exact addresses in
				<code>server.trusted_proxies</code>, keep the server on a private interface and forward
				WebSocket upgrades. The proxy must overwrite <code>X-Forwarded-For</code>.
			</li>
		</ul>
		<p>
			A proxy carries signalling only. Clients still need to reach the media port directly, over UDP
			or TCP.
		</p>

		<h2 id="backup">Back up and restore</h2>
		<p>
			Stop the server, then write a backup to a new directory outside the data directory. The backup
			holds your database, configuration and keys, so keep it private.
		</p>
		<CodeBlock lang="bash" code={`voice-server --data-dir ./data backup --output ./voice-backup`} />
		<p>
			Wait for <code>BACKUP_COMPLETE</code> before you archive the directory. To restore, stop the
			old instance, copy the backup into an owner-only directory and point
			<code>--data-dir</code> at it. Reapply any environment overrides, and check that the fingerprint
			matches what clients already trust.
		</p>

		<h2 id="build">Build from source</h2>
		<p>
			You need Bun 1.4.5, a Linux toolchain and OpenSSL 3.5.9 or newer development files. On Debian
			13:
		</p>
		<CodeBlock
			lang="bash"
			code={`sudo apt-get install build-essential ca-certificates libssl-dev meson ninja-build pkg-config
cd backend
bun install --frozen-lockfile --ignore-scripts
bun run build`}
		/>
		<p>
			The result embeds the media worker and downloads nothing at startup. More detail is in the
			<a
				href="https://github.com/WardPearce/korero/blob/main/docs/deployment.md"
				target="_blank"
				rel="noopener noreferrer"
			>
				deployment guide
			</a>.
		</p>
	</main>
</div>

<SiteFooter />
