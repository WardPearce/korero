<script lang="ts">
	import SiteHeader from '#lib/components/SiteHeader.svelte';
	import CodeBlock from '#lib/components/CodeBlock.svelte';
	import DocsToc from '#lib/components/DocsToc.svelte';
	import SiteFooter from '#lib/components/SiteFooter.svelte';
	import BookOpen from '@lucide/svelte/icons/book-open';
	import Container from '@lucide/svelte/icons/container';
	import Download from '@lucide/svelte/icons/download';
	import FileCog from '@lucide/svelte/icons/file-cog';
	import Hammer from '@lucide/svelte/icons/hammer';
	import Terminal from '@lucide/svelte/icons/terminal';

	const repo = 'https://github.com/WardPearce/korero';
	const deploymentGuide = `${repo}/blob/main/docs/deployment.md`;

	const toc = [
		{ id: 'before', label: 'Before you start', kicker: 'Host, ports and addresses' },
		{ id: 'docker', label: 'Deploy with Docker', kicker: 'Compose, AMD64 and ARM64' },
		{ id: 'binary', label: 'Deploy the binary', kicker: 'Linux executable and systemd' },
		{ id: 'first-owner', label: 'Claim the server', kicker: 'Setup token and fingerprint' },
		{ id: 'configure', label: 'Configure', kicker: 'TOML and environment' },
		{ id: 'tls', label: 'TLS and proxies', kicker: 'Certificates and pinning' },
		{ id: 'update', label: 'Update', kicker: 'New releases' },
		{ id: 'backup', label: 'Back up and restore', kicker: 'Offline snapshots' },
		{ id: 'troubleshoot', label: 'Troubleshoot', kicker: 'Common problems' },
		{ id: 'build', label: 'Build from source', kicker: 'Bun and native toolchain' }
	];

	const paths = [
		{
			title: 'Docker',
			body: 'One compose file holds the whole configuration. The easiest way to run and update a server.',
			tech: 'Recommended',
			href: '#docker',
			icon: Container
		},
		{
			title: 'Linux binary',
			body: 'A single executable with the media worker built in. Run it under systemd on any recent distribution.',
			tech: 'AMD64 and ARM64',
			href: '#binary',
			icon: Terminal
		},
		{
			title: 'From source',
			body: 'Compile the same self-contained executable yourself with Bun and a native toolchain.',
			tech: 'Bun 1.4.5',
			href: '#build',
			icon: Hammer
		}
	];

	const ports = [
		['8443', 'TCP', 'HTTPS and secure WebSocket (signalling)'],
		['8444', 'UDP', 'WebRTC media'],
		['8444', 'TCP', 'WebRTC media fallback']
	];

	const settings = [
		['server.name', 'The name clients display.'],
		[
			'server.registration',
			'Who can create accounts: <code>open</code> (the default), <code>invitation</code>, <code>admin</code> or <code>disabled</code>.'
		],
		[
			'server.password',
			'A shared password for sign-in and registration. Empty by default; invitations work without it.'
		],
		[
			'server.public_addresses',
			'The public IPs or hostnames clients use for signalling. Also added to the certificate.'
		],
		['server.max_users', 'How many people can be online at once. 128 by default.'],
		['media.announced_address', 'The public IP or hostname clients send media to.'],
		['media.target_audio_bitrate', 'Voice quality, from 32 to 128 kbit/s. 64 kbit/s by default.'],
		['messaging.persistence', 'Keep message history on the server. On by default.'],
		['messaging.retention_hours', 'How long history is kept, up to one year. One week by default.'],
		[
			'remote-account-host.registration',
			'Let people store encrypted hosted accounts on this server: <code>open</code> or <code>closed</code> (the default).'
		],
		['authentication.refresh_seconds', 'How long a device stays signed in. 90 days by default.']
	];
</script>

<svelte:head>
	<title>Host a Kōrero server: Docker and binary</title>
	<meta
		name="description"
		content="Run a Kōrero voice server with Docker Compose or the standalone Linux binary, then claim it, configure it, update it and back it up."
	/>
</svelte:head>

<SiteHeader />

<section class="host-hero border-b border-border">
	<div class="mx-auto max-w-7xl px-6 py-16 lg:py-20">
		<p class="text-sm text-muted-foreground">
			<span class="font-semibold text-primary">Self-hosting</span>, your server, your data
		</p>
		<h1 class="mt-4 max-w-3xl text-4xl leading-[1.05] font-semibold sm:text-5xl">
			Host a Kōrero server
		</h1>
		<p class="mt-5 max-w-2xl text-lg text-muted-foreground">
			Run it in a container or as a single Linux binary. Both read the same configuration and keep
			all their state in one data directory, so you can switch between them later.
		</p>
		<div class="mt-8 flex flex-wrap gap-3">
			<a
				href="{repo}/releases/latest"
				target="_blank"
				rel="noopener noreferrer"
				class="hero-button primary"
			>
				<Download size={16} /> Latest release
			</a>
			<a
				href="{repo}/blob/main/backend/server.example.toml"
				target="_blank"
				rel="noopener noreferrer"
				class="hero-button"
			>
				<FileCog size={16} /> Example configuration
			</a>
			<a
				href="{repo}/blob/main/docs/deployment.md"
				target="_blank"
				rel="noopener noreferrer"
				class="hero-button"
			>
				<BookOpen size={16} /> Deployment guide
			</a>
		</div>

		<h2 class="mt-16 text-xl font-semibold">Choose how to run it</h2>
		<ul class="paths">
			{#each paths as path (path.href)}
				<li>
					<a href={path.href} class="path-card">
						<span class="path-icon"><path.icon size={18} /></span>
						<span class="block font-semibold">{path.title}</span>
						<span class="mt-1 mb-4 block text-sm text-muted-foreground">{path.body}</span>
						<span class="path-tech">{path.tech}</span>
					</a>
				</li>
			{/each}
		</ul>
	</div>
</section>

<div class="mx-auto grid max-w-7xl gap-12 px-6 py-16 lg:grid-cols-[15rem_minmax(0,1fr)]">
	<DocsToc items={toc} source={{ href: deploymentGuide, label: 'Read the full guide' }} />

	<main id="main" class="docs host-docs max-w-[48rem] min-w-0">
		<h2 id="before"><a href="#before" class="heading-link">Before you start</a></h2>
		<p>You need:</p>
		<ul>
			<li>
				A Linux machine that clients can reach. A small VPS or a home server is plenty for a group
				of friends.
			</li>
			<li>
				A local filesystem for the data directory. SQLite needs file locking, so avoid network
				shares.
			</li>
			<li>One server per data directory, running as its own system user.</li>
		</ul>
		<p>Open these ports on the host firewall, and forward them if the host is behind NAT:</p>
		<div class="table-wrap">
			<table>
				<thead><tr><th>Port</th><th>Protocol</th><th>Purpose</th></tr></thead>
				<tbody>
					{#each ports as [port, proto, purpose] (port + proto)}
						<tr><td><code>{port}</code></td><td>{proto}</td><td>{purpose}</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p>
			Each extra media worker uses the next consecutive port. On a LAN, nothing else is needed.
			Clients on the internet need a public address for media: set it with
			<code>media.announced_address</code>, or <code>VOICE_MEDIA_ANNOUNCED_ADDRESS</code> in the environment.
			Behind CGNAT, inbound IPv4 may not work at all; use IPv6 or a VPN such as WireGuard or Tailscale
			instead.
		</p>

		<h2 id="docker"><a href="#docker" class="heading-link">Deploy with Docker</a></h2>
		<p>
			The image supports AMD64 and ARM64. Put the TOML directly in <code>VOICE_CONFIG</code> so the
			whole configuration lives in your compose file. This one sets the server name, who may
			register, a shared password and the public addresses clients use for signalling and media.
			Every setting is optional; leave one out to use its default. See
			<a href="#configure">Configure</a> for the rest.
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
    environment:
      VOICE_DATA_DIR: /data
      VOICE_CONFIG: |
        [server]
        name = "My Kōrero server"
        registration = "invitation"
        # Shared password for sign-in and registration; "" disables it.
        # Invitations still work without it. Set VOICE_SERVER_PASSWORD
        # instead to keep the secret out of this file.
        password = ""
        # The public IP or hostname clients use for HTTPS/WSS.
        public_addresses = ["203.0.113.10"]
        [media]
        # The public IP or hostname clients can reach the media port on.
        announced_address = "203.0.113.10"
        # Voice quality in bits per second (32000-128000).
        target_audio_bitrate = 64000
        [messaging]
        # Keep message history for one week.
        retention_hours = 168
volumes:
  voice-data:`}
		/>
		<p class="note">
			Inline TOML is recognised when it begins with a section header or comment. Keep it to one
			continuous block with no blank lines.
		</p>
		<p>Start the server and read the log for the endpoint, fingerprint and setup token.</p>
		<CodeBlock
			lang="bash"
			code={`docker compose up -d
docker compose logs voice-server`}
		/>
		<p>
			To change a setting, edit the compose file and run <code>docker compose up -d</code> again.
			The image has a health check, so <code>docker compose ps</code> shows when the server is ready.
		</p>
		<p>
			The named volume keeps the database and TLS identity. The container runs as UID and GID 10001,
			so if you use a bind mount instead, make that user the owner of the directory first. For IPv6,
			enable it on the host and the Docker network, and set
			<code>media.announced_ipv6</code>.
		</p>
		<p>
			To build the image yourself, clone the repository and run
			<code>docker compose up -d --build</code> from its root.
		</p>

		<h2 id="binary"><a href="#binary" class="heading-link">Deploy the binary</a></h2>
		<p>
			Each release attaches standalone Linux AMD64 and ARM64 executables and a
			<code>SHA256SUMS</code> file. The binary embeds its runtime and media worker. The host needs glibc,
			libstdc++ and OpenSSL 3.5.9 or newer shared libraries.
		</p>
		<ol class="steps">
			<li>
				Download the binary for your architecture and <code>SHA256SUMS</code> from the
				<a href="{repo}/releases/latest" target="_blank" rel="noopener noreferrer">
					latest release
				</a>, then verify it.
				<CodeBlock lang="bash" code="sha256sum --ignore-missing -c SHA256SUMS" />
			</li>
			<li>
				Install it, and create a system user whose home is the data directory.
				<CodeBlock
					lang="bash"
					code={`sudo install -m 0755 voice-server-linux-amd64 /usr/local/bin/voice-server
sudo useradd --system --home /var/lib/korero --create-home --shell /usr/sbin/nologin korero`}
				/>
			</li>
			<li>
				Add a systemd unit at <code>/etc/systemd/system/korero.service</code>. Set the announced
				address if clients connect from the internet.
				<CodeBlock
					lang="ini"
					label="korero.service"
					code={`[Unit]
Description=Kōrero voice server
After=network-online.target
Wants=network-online.target

[Service]
User=korero
ExecStart=/usr/local/bin/voice-server --data-dir /var/lib/korero
Restart=on-failure
Environment=VOICE_MEDIA_ANNOUNCED_ADDRESS=203.0.113.10
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target`}
				/>
			</li>
			<li>
				Start it. On first start it creates a Lobby channel, a TLS identity, a default
				<code>server.toml</code> and a setup token.
				<CodeBlock
					lang="bash"
					code={`sudo systemctl daemon-reload
sudo systemctl enable --now korero
journalctl -u korero`}
				/>
			</li>
		</ol>

		<h2 id="first-owner"><a href="#first-owner" class="heading-link">Claim the server</a></h2>
		<p>
			The first start prints the local signalling address (for example
			<code>192.168.1.100:8443</code>), the TLS public-key fingerprint and a one-time setup token.
			If you set <code>server.public_addresses</code>, it also prints a <code>Public</code> endpoint;
			share that one with remote clients.
		</p>
		<ol class="steps">
			<li>Open Kōrero and choose <strong>Connect to server</strong>.</li>
			<li>
				Enter the address (the <code>Public</code> one if configured) and check that the fingerprint matches
				the one in the log.
			</li>
			<li>Enter the setup token to become the server's owner.</li>
		</ol>
		<p class="note">
			The token lasts 15 minutes and anyone holding it can claim the server, so treat the logs as
			sensitive until you have used it.
		</p>
		<p>If the token expires first, stop the server, issue a new one and start it again.</p>
		<CodeBlock
			lang="bash"
			code={`# Docker
docker compose stop voice-server
docker compose run --rm --no-deps voice-server admin setup-token --yes
docker compose up -d

# Binary
sudo systemctl stop korero
sudo -u korero voice-server --data-dir /var/lib/korero admin setup-token --yes
sudo systemctl start korero`}
		/>
		<p>
			Share the address and fingerprint with other people over a channel you trust. Their app checks
			the fingerprint before it sends any credentials.
		</p>

		<h2 id="configure"><a href="#configure" class="heading-link">Configure</a></h2>
		<p>
			Every setting is optional, and
			<a
				href="{repo}/blob/main/backend/server.example.toml"
				target="_blank"
				rel="noopener noreferrer"
			>
				server.example.toml
			</a>
			documents them all with their defaults and limits. In Docker, the TOML goes in
			<code>VOICE_CONFIG</code>. The binary reads <code>server.toml</code> in its data directory. Restart
			the server to apply changes.
		</p>
		<p>
			Any setting can also be an environment variable named
			<code>VOICE_&lt;SECTION&gt;_&lt;KEY&gt;</code>, such as <code>VOICE_SERVER_PORT</code>, with
			dashes in the section name written as underscores. Environment variables win over TOML. Lists,
			numbers and booleans are written as JSON. Validate the configuration before you restart.
		</p>
		<CodeBlock
			lang="bash"
			code={`# Docker
docker compose run --rm voice-server config validate

# Binary
sudo -u korero voice-server --data-dir /var/lib/korero config validate`}
		/>
		<p>Settings most servers change first:</p>
		<div class="table-wrap">
			<table>
				<thead><tr><th class="w-[45%]">Setting</th><th>What it does</th></tr></thead>
				<tbody>
					{#each settings as [key, description] (key)}
						<tr>
							<td><code>{key}</code></td>
							<!-- eslint-disable-next-line svelte/no-at-html-tags -- static strings defined above -->
							<td>{@html description}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p>
			Rate limits, storage quotas and media workers are under <code>[limits]</code>,
			<code>[messaging]</code> and <code>[media]</code> in the example file.
		</p>

		<h2 id="tls"><a href="#tls" class="heading-link">TLS and proxies</a></h2>
		<p>
			The server always uses HTTPS. You don't need a domain or a certificate authority: clients pin
			the server's public key on first connect. Choose how it gets its certificate with
			<code>tls.mode</code>.
		</p>
		<dl class="options">
			<div>
				<dt><code>self-signed</code></dt>
				<dd>
					The default. The server generates and renews its own certificate, and clients pin its
					public key.
				</dd>
			</div>
			<div>
				<dt><code>manual</code></dt>
				<dd>
					Loads your PEM files from <code>tls.certificate</code> and <code>tls.private_key</code>.
					The key must be readable only by the server user.
				</dd>
			</div>
			<div>
				<dt><code>proxy</code></dt>
				<dd>
					A reverse proxy terminates TLS. List its exact addresses in
					<code>server.trusted_proxies</code>, keep the server on a private interface and forward
					WebSocket upgrades.
				</dd>
			</div>
		</dl>
		<p class="note">
			A proxy carries signalling only. Clients still need to reach the media port directly, over UDP
			or TCP.
		</p>

		<h2 id="update"><a href="#update" class="heading-link">Update</a></h2>
		<p>
			Back up first, then replace the server and start it again. The database migrates itself on
			start, and clients keep trusting the same fingerprint.
		</p>
		<CodeBlock
			lang="bash"
			code={`# Docker
docker compose pull
docker compose up -d

# Binary: download and verify the new release first
sudo systemctl stop korero
sudo install -m 0755 voice-server-linux-amd64 /usr/local/bin/voice-server
sudo systemctl start korero`}
		/>
		<p>
			Check <code>voice-server --version</code> and the
			<a href="{repo}/releases" target="_blank" rel="noopener noreferrer">release notes</a> for changes
			that need action.
		</p>

		<h2 id="backup"><a href="#backup" class="heading-link">Back up and restore</a></h2>
		<p>
			Stop the server, then write a backup to a new directory outside the data directory. It holds
			the database, configuration and keys, including inline <code>VOICE_CONFIG</code>, so keep it
			private.
		</p>
		<CodeBlock
			lang="bash"
			code={`# Docker: the backups directory must be owned by UID 10001
docker compose stop voice-server
mkdir -p backups && sudo chown 10001:10001 backups
docker compose run --rm --no-deps -v "$PWD/backups:/backups" voice-server \\
  backup --output /backups/korero-$(date +%F)
docker compose up -d

# Binary
sudo systemctl stop korero
sudo install -d -o korero -g korero -m 0700 /var/backups/korero
sudo -u korero voice-server --data-dir /var/lib/korero backup --output /var/backups/korero/$(date +%F)
sudo systemctl start korero`}
		/>
		<p>
			Wait for <code>BACKUP_COMPLETE</code> before you archive the directory. To restore, stop the old
			instance, copy the backup into an owner-only directory and point the data directory at it. Reapply
			any environment overrides, and check that the fingerprint matches what clients already trust. A
			restore can bring back devices that were signed in when the backup was taken, so revoke them again
			if needed.
		</p>

		<h2 id="troubleshoot"><a href="#troubleshoot" class="heading-link">Troubleshoot</a></h2>
		<dl class="options">
			<div>
				<dt>People can join but nobody hears anything</dt>
				<dd>
					Media isn't reaching the server. Check that port 8444 is open and forwarded for UDP and
					TCP, and that <code>media.announced_address</code> is the address clients use.
				</dd>
			</div>
			<div>
				<dt>The app warns that the fingerprint changed</dt>
				<dd>
					Don't continue until you know why. A new data directory, a restored backup from another
					server or <code>identity rotate</code> all change it. While the server is stopped,
					<code>voice-server identity fingerprint</code> prints the current one.
				</dd>
			</div>
			<div>
				<dt>The server won't start after a config change</dt>
				<dd>
					Run <code>config validate</code>; it names the setting that is wrong. Remember that
					environment variables override the TOML.
				</dd>
			</div>
			<div>
				<dt>Permission denied on the data directory</dt>
				<dd>
					The directory must be owned by the server user: <code>korero</code> for the binary, UID 10001
					in Docker.
				</dd>
			</div>
		</dl>

		<h2 id="build"><a href="#build" class="heading-link">Build from source</a></h2>
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
			The result is the same self-contained executable as a release, and downloads nothing at
			startup. More detail is in the
			<a href="{repo}/blob/main/docs/deployment.md" target="_blank" rel="noopener noreferrer">
				deployment guide
			</a>.
		</p>
	</main>
</div>

<SiteFooter />

<style>
	.host-hero {
		background: var(--muted);
	}
	.paths {
		display: grid;
		gap: 0.75rem;
		margin: 1.25rem 0 0;
		padding: 0;
		list-style: none;
	}
	@media (min-width: 768px) {
		.paths {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
	}
	.path-card {
		display: flex;
		flex-direction: column;
		height: 100%;
		border: 1px solid var(--border);
		border-radius: 12px;
		background: var(--background);
		padding: 1.1rem 1.15rem 1rem;
		transition: border-color 0.15s ease;
	}
	.path-card:hover {
		border-color: var(--input);
	}
	.path-icon {
		margin-bottom: 0.75rem;
		color: var(--primary);
	}
	.path-tech {
		margin-top: auto;
		border-top: 1px solid var(--border);
		padding-top: 0.6rem;
		color: var(--primary);
		font-size: 0.8125rem;
	}

	.hero-button {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		border: 1px solid var(--border);
		border-radius: 9px;
		background: var(--card);
		padding: 0.6rem 1rem;
		font-size: 0.9rem;
		font-weight: 500;
		transition: border-color 0.15s ease;
	}
	.hero-button:hover {
		border-color: var(--input);
	}
	.hero-button.primary {
		border-color: var(--primary);
		background: var(--primary);
		color: var(--primary-foreground);
	}
	.hero-button.primary:hover {
		filter: brightness(1.08);
	}

	.host-docs > h2:first-child {
		margin-top: 0;
		padding-top: 0;
		border-top: 0;
	}
	.host-docs > p,
	.host-docs > ul {
		margin-top: 1rem;
	}
	.host-docs :global(.heading-link) {
		color: inherit;
	}
	.host-docs :global(.heading-link:hover) {
		text-decoration: none;
	}
	.host-docs :global(.heading-link)::after {
		content: '#';
		margin-left: 0.5rem;
		opacity: 0;
		color: var(--input);
		font-weight: 400;
		transition: opacity 0.15s ease;
	}
	.host-docs :global(.heading-link:hover)::after,
	.host-docs :global(.heading-link:focus-visible)::after {
		opacity: 1;
	}

	.steps {
		counter-reset: step;
		margin-top: 1rem;
		padding-left: 0;
		list-style: none;
	}
	.steps > li {
		position: relative;
		counter-increment: step;
		margin-top: 1.25rem;
		padding-left: 2.5rem;
	}
	.steps > li::before {
		content: counter(step);
		position: absolute;
		top: 0;
		left: 0;
		display: grid;
		place-items: center;
		width: 1.75rem;
		height: 1.75rem;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--card);
		color: var(--primary);
		font-size: 0.8125rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}

	.note {
		border-left: 2px solid var(--primary);
		padding: 0.15rem 0 0.15rem 1rem !important;
		color: var(--muted-foreground);
		font-size: 0.9375rem;
	}

	.options {
		display: grid;
		gap: 0.75rem;
		margin: 1rem 0 0;
		border: 1px solid var(--border);
		border-radius: 12px;
		background: color-mix(in srgb, var(--card) 45%, transparent);
		padding: 1.1rem 1.25rem;
		font-size: 0.9375rem;
	}
	.options dt {
		font-weight: 600;
	}
	.options dd {
		margin: 0.15rem 0 0;
		color: var(--muted-foreground);
	}

	.table-wrap {
		margin-top: 1.25rem;
		overflow-x: auto;
		border: 1px solid var(--border);
		border-radius: 12px;
		background: color-mix(in srgb, var(--card) 55%, transparent);
	}
	.table-wrap table {
		padding-left: 0;
	}
	.table-wrap tbody tr:last-child td {
		border-bottom: 0;
	}
</style>
