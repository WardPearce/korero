<script lang="ts">
	import { onMount } from 'svelte';
	import SiteHeader from '#lib/components/SiteHeader.svelte';
	import CodeBlock from '#lib/components/CodeBlock.svelte';
	import SiteFooter from '#lib/components/SiteFooter.svelte';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import Braces from '@lucide/svelte/icons/braces';
	import FileJson from '@lucide/svelte/icons/file-json';
	import Fingerprint from '@lucide/svelte/icons/fingerprint';
	import MonitorPlay from '@lucide/svelte/icons/monitor-play';
	import Radio from '@lucide/svelte/icons/radio';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';

	const toc = [
		{ id: 'http', label: 'HTTP', kicker: 'REST endpoints' },
		{ id: 'websocket', label: 'WebSocket', kicker: 'Envelopes and handshake' },
		{ id: 'requests', label: 'Requests', kicker: 'Application messages' },
		{ id: 'direct', label: 'Direct messages', kicker: 'Encryption and delivery' },
		{ id: 'webrtc', label: 'WebRTC', kicker: 'Voice, screen and camera' },
		{ id: 'events', label: 'Events', kicker: 'Server push' },
		{ id: 'errors', label: 'Errors', kicker: 'Codes and statuses' }
	];

	const layers = [
		{
			title: 'Sign in',
			body: 'Read the server info, prove who you are by signing a challenge with your key, then swap the session for a short-lived ticket.',
			tech: 'HTTPS with JSON',
			href: '#http',
			icon: Braces
		},
		{
			title: 'Stay connected',
			body: 'Open one socket, authenticate with the ticket and receive a snapshot of the server. Send requests and listen for live events.',
			tech: 'WebSocket with JSON envelopes',
			href: '#websocket',
			icon: Radio
		},
		{
			title: 'Talk and share',
			body: 'Join a channel, then negotiate send and receive transports for voice, screen and camera.',
			tech: 'WebRTC with Opus and VP8',
			href: '#webrtc',
			icon: MonitorPlay
		}
	];

	const repo = 'https://github.com/WardPearce/korero/blob/main/docs';

	let active = $state('http');

	onMount(() => {
		const sections = toc
			.map((item) => document.getElementById(item.id))
			.filter((section): section is HTMLElement => section !== null);

		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) {
						active = entry.target.id;
						break;
					}
				}
			},
			{ rootMargin: '-96px 0px -68% 0px' }
		);

		sections.forEach((section) => observer.observe(section));
		return () => observer.disconnect();
	});
</script>

<svelte:head>
	<title>Protocol v1: Kōrero client and server API</title>
	<meta
		name="description"
		content="Kōrero protocol v1: HTTPS routes, WebSocket envelopes, application requests, encrypted direct messages, WebRTC negotiation, events and error codes."
	/>
</svelte:head>

<SiteHeader />

<section class="protocol-hero border-b border-border">
	<div class="mx-auto max-w-7xl px-6 py-16 lg:py-20">
		<p class="text-sm text-muted-foreground">
			<span class="font-semibold text-primary">Protocol v1</span>, stable wire format
		</p>
		<h1 class="mt-4 max-w-3xl text-4xl leading-[1.05] font-semibold sm:text-5xl">
			Build on the Kōrero protocol
		</h1>
		<p class="mt-5 max-w-2xl text-lg text-muted-foreground">
			Write a bot, your own client or an integration in any language. The official apps use exactly
			this protocol, so anything they can do, yours can too.
		</p>
		<div class="mt-8 flex flex-wrap gap-3">
			<a
				href="{repo}/protocol-v1.schema.json"
				target="_blank"
				rel="noopener noreferrer"
				class="hero-button primary"
			>
				<FileJson size={16} /> JSON Schema
			</a>
			<a
				href="{repo}/authentication.md"
				target="_blank"
				rel="noopener noreferrer"
				class="hero-button"
			>
				<ShieldCheck size={16} /> Authentication
			</a>
			<a
				href="{repo}/server-identity.md"
				target="_blank"
				rel="noopener noreferrer"
				class="hero-button"
			>
				<Fingerprint size={16} /> Server identity
			</a>
		</div>

		<h2 class="mt-16 text-xl font-semibold">How a client connects</h2>
		<ol class="flow">
			{#each layers as layer (layer.href)}
				<li>
					<a href={layer.href} class="flow-step">
						<span class="flow-icon"><layer.icon size={18} /></span>
						<span class="block font-semibold">{layer.title}</span>
						<span class="mt-1 mb-4 block text-sm text-muted-foreground">{layer.body}</span>
						<span class="flow-tech">{layer.tech}</span>
					</a>
				</li>
			{/each}
		</ol>
	</div>
</section>

<div class="mx-auto grid max-w-7xl gap-12 px-6 py-16 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-12">
	<nav aria-label="On this page" class="min-w-0 lg:sticky lg:top-20 lg:self-start">
		<div class="toc-card">
			<p class="toc-heading">On this page</p>
			<ol class="toc-list">
				{#each toc as t (t.id)}
					<li>
						<a
							href="#{t.id}"
							class="toc-link"
							class:active={active === t.id}
							aria-current={active === t.id ? 'location' : undefined}
						>
							<span class="toc-label">{t.label}</span>
							<span class="toc-kicker">{t.kicker}</span>
						</a>
					</li>
				{/each}
			</ol>
			<a href="{repo}/protocol.md" target="_blank" rel="noopener noreferrer" class="toc-source">
				Read the source doc <ArrowRight size={14} />
			</a>
		</div>
	</nav>

	<main id="main" class="docs protocol-docs max-w-[58rem] min-w-0">
		<section class="conventions" aria-labelledby="conventions-title">
			<h2 id="conventions-title" class="conventions-title">Conventions</h2>
			<dl>
				<div>
					<dt>Times</dt>
					<dd>Unix milliseconds. Durations named <code>…Seconds</code> are in seconds.</dd>
				</div>
				<div>
					<dt>IDs</dt>
					<dd>
						Opaque lowercase UUID-formatted strings. Clients generate their own direct message IDs.
					</dd>
				</div>
				<div>
					<dt>Request IDs</dt>
					<dd>A positive, increasing integer in each WebSocket envelope.</dd>
				</div>
				<div>
					<dt>Compatibility</dt>
					<dd>Preserve unknown fields in extensible media data, and ignore unknown events.</dd>
				</div>
				<div>
					<dt>Schemas</dt>
					<dd>
						Every request is in the
						<a href="{repo}/protocol-v1.schema.json" target="_blank" rel="noopener noreferrer">
							JSON Schema
						</a>. Select one with a reference such as <code>#/$defs/websocketRequest</code>.
					</dd>
				</div>
			</dl>
		</section>

		<h2 id="http"><a href="#http" class="heading-link">HTTP</a></h2>
		<p>
			Set <code>Content-Type: application/json</code> on requests with a body. Authenticated routes
			require <code>Authorization: Bearer &lt;accessToken&gt;</code>. Error responses carry
			<code>
				&#123;"error":&#123;"code":"AUTH_FAILED","message":"Authentication failed"&#125;&#125;
			</code>. Use the error code for control flow. Error prose may change. Successful writes use
			200 or 201. A credential-bearing response carries <code>Cache-Control: no-store</code>.
		</p>
		<div class="table-wrap">
			<table class="http-table">
				<thead>
					<tr><th>Method and path</th><th>Auth</th><th>Input</th><th>Successful result</th></tr>
				</thead>
				<tbody>
					<tr>
						<td class="method"><span class="verb GET">GET</span><code>/<wbr />health</code></td>
						<td>Public</td>
						<td>—</td>
						<td><code>&#123;status:"ok"&#125;</code></td>
					</tr>
					<tr>
						<td class="method"><span class="verb GET">GET</span><code>/<wbr />ready</code></td>
						<td>Public</td>
						<td>—</td>
						<td>
							<code>&#123;status:"ready"&#125;</code>, or 503 with
							<code>&#123;status:"unavailable"&#125;</code>
						</td>
					</tr>
					<tr>
						<td class="method">
							<span class="verb GET">GET</span><code>
								/<wbr />api/<wbr />v1/<wbr />server/<wbr />info
							</code>
						</td>
						<td>Public</td>
						<td>—</td>
						<td>
							<code>
								serverId, name, version, protocolVersions, registration, setupRequired,
								passwordRequired, invitationPasswordBypass, serverAdministration, bannerImageUrl,
								richChat?, maxWebSocketBytes?, profilePictures?, fingerprint?
							</code>
						</td>
					</tr>
					<tr>
						<td class="method">
							<span class="verb GET">GET</span><code>
								/<wbr />api/<wbr />v1/<wbr />server/<wbr />capabilities
							</code>
						</td>
						<td>Optional</td>
						<td>—</td>
						<td>
							<code>
								protocolVersions, websocketPath, audio, targetAudioBitrate, heartbeatSeconds,
								maxWebSocketBytes, udp, tcp, textPersistence, iceServers?
							</code>
						</td>
					</tr>
					<tr>
						<td class="method">
							<span class="verb POST">POST</span><code>
								/<wbr />api/<wbr />v1/<wbr />auth/<wbr />identity/<wbr />challenge
							</code>
						</td>
						<td>Public</td>
						<td><code>operation, publicKey, deviceName, origin</code></td>
						<td>Single-use challenge</td>
					</tr>
					<tr>
						<td class="method">
							<span class="verb POST">POST</span><code>
								/<wbr />api/<wbr />v1/<wbr />auth/<wbr />identity/<wbr />login
							</code>
						</td>
						<td>
							Signed login challenge and configured server password for accounts created without an
							invitation
						</td>
						<td><code>id, signature, password?</code></td>
						<td>Account and new session</td>
					</tr>
					<tr>
						<td class="method">
							<span class="verb POST">POST</span><code>
								/<wbr />api/<wbr />v1/<wbr />admin/<wbr />bootstrap
							</code>
						</td>
						<td>Setup token, signed bootstrap challenge, and server password when configured</td>
						<td><code>token, displayName, deviceName, identity, password?</code></td>
						<td>Account and session</td>
					</tr>
					<tr>
						<td class="method">
							<span class="verb POST">POST</span><code>
								/<wbr />api/<wbr />v1/<wbr />auth/<wbr />register
							</code>
						</td>
						<td>
							Signed registration challenge, registration policy, and server password when
							configured for registration without an invitation
						</td>
						<td><code>displayName, deviceName, identity, invitation?, password?</code></td>
						<td>Account and session</td>
					</tr>
					<tr>
						<td class="method">
							<span class="verb POST">POST</span><code>
								/<wbr />api/<wbr />v1/<wbr />auth/<wbr />refresh
							</code>
						</td>
						<td>Refresh token in body</td>
						<td><code>refreshToken</code></td>
						<td>Rotated session credentials</td>
					</tr>
					<tr>
						<td class="method">
							<span class="verb POST">POST</span><code>
								/<wbr />api/<wbr />v1/<wbr />auth/<wbr />logout
							</code>
						</td>
						<td>Access token</td>
						<td>—</td>
						<td><code>&#123;&#125;</code></td>
					</tr>
					<tr>
						<td class="method">
							<span class="verb POST">POST</span><code>
								/<wbr />api/<wbr />v1/<wbr />auth/<wbr />logout-all
							</code>
						</td>
						<td>Access token</td>
						<td>—</td>
						<td><code>&#123;&#125;</code></td>
					</tr>
					<tr>
						<td class="method">
							<span class="verb POST">POST</span><code>
								/<wbr />api/<wbr />v1/<wbr />auth/<wbr />connection-ticket
							</code>
						</td>
						<td>Access token</td>
						<td>—</td>
						<td><code>&#123;ticket, expiresAt&#125;</code></td>
					</tr>
					<tr>
						<td class="method">
							<span class="verb GET">GET</span><code>
								/<wbr />api/<wbr />v1/<wbr />connections/<wbr />:id
							</code>
						</td>
						<td>
							Access token for the same session or a viewer with access to the member’s channel
						</td>
						<td>—</td>
						<td><code>&#123;displayName, channelName, connectedSeconds, latencyMs&#125;</code></td>
					</tr>
					<tr>
						<td class="method">
							<span class="verb GET">GET</span><code>/<wbr />api/<wbr />v1/<wbr />account</code>
						</td>
						<td>Access token</td>
						<td>—</td>
						<td>Account</td>
					</tr>
					<tr>
						<td class="method">
							<span class="verb PATCH">PATCH</span><code>/<wbr />api/<wbr />v1/<wbr />account</code>
						</td>
						<td>Access token</td>
						<td><code>displayName</code></td>
						<td>Account</td>
					</tr>
					<tr>
						<td class="method">
							<span class="verb PATCH">PATCH</span><code>
								/<wbr />api/<wbr />v1/<wbr />account/<wbr />picture
							</code>
						</td>
						<td>Access token</td>
						<td><code>data</code>, a base64 PNG or <code>null</code> to remove the picture</td>
						<td><code>&#123;avatarId&#125;</code></td>
					</tr>
					<tr>
						<td class="method">
							<span class="verb GET">GET</span><code>
								/<wbr />api/<wbr />v1/<wbr />account/<wbr />picture/<wbr />:accountId
							</code>
						</td>
						<td>Access token</td>
						<td>—</td>
						<td>
							<code>&#123;avatarId, data&#125;</code>, with both fields null when there is no
							picture
						</td>
					</tr>
					<tr>
						<td class="method">
							<span class="verb GET">GET</span><code>
								/<wbr />api/<wbr />v1/<wbr />account/<wbr />sessions
							</code>
						</td>
						<td>Access token</td>
						<td>—</td>
						<td>Array of <code>id, deviceName, createdAt, lastActive, expiresAt</code></td>
					</tr>
					<tr>
						<td class="method">
							<span class="verb POST">POST</span><code>
								/<wbr />api/<wbr />v1/<wbr />chat/<wbr />attachments
							</code>
						</td>
						<td>Access token and matching connection</td>
						<td><code>connectionId, channelId, text, html?, name, data</code></td>
						<td><code>&#123;messageId&#125;</code></td>
					</tr>
					<tr>
						<td class="method">
							<span class="verb GET">GET</span><code>
								/<wbr />api/<wbr />v1/<wbr />chat/<wbr />attachments/<wbr />:messageId
							</code>
						</td>
						<td>Access token and matching connection</td>
						<td>Query <code>connectionId</code></td>
						<td><code>&#123;data&#125;</code></td>
					</tr>
					<tr>
						<td class="method">
							<span class="verb DELETE">DELETE</span><code>
								/<wbr />api/<wbr />v1/<wbr />account/<wbr />sessions/<wbr />:id
							</code>
						</td>
						<td>Access token</td>
						<td>—</td>
						<td><code>&#123;&#125;</code></td>
					</tr>
					<tr>
						<td class="method">
							<span class="verb GET">GET</span><code>
								/<wbr />api/<wbr />v1/<wbr />admin/<wbr />accounts
							</code>
						</td>
						<td><code>manageRoles</code></td>
						<td>Query <code>after?</code> account ID</td>
						<td>
							<code>
								accounts, next, roles, canDefineRoles, builtInRoles, customRoles,
								assignablePermissions, defaultRole, registrationPermissions
							</code>
						</td>
					</tr>
					<tr>
						<td class="method">
							<span class="verb PATCH">PATCH</span><code>
								/<wbr />api/<wbr />v1/<wbr />admin/<wbr />roles
							</code>
						</td>
						<td><code>manageRoles</code></td>
						<td><code>accountId, role</code></td>
						<td><code>&#123;role&#125;</code></td>
					</tr>
					<tr>
						<td class="method">
							<span class="verb PATCH">PATCH</span><code>
								/<wbr />api/<wbr />v1/<wbr />admin/<wbr />badges
							</code>
						</td>
						<td><code>manageRoles</code></td>
						<td><code>accountId, badge</code></td>
						<td><code>&#123;badge&#125;</code></td>
					</tr>
					<tr>
						<td class="method">
							<span class="verb POST">POST</span><code>
								/<wbr />api/<wbr />v1/<wbr />admin/<wbr />roles
							</code>
						</td>
						<td>Administrator or Owner</td>
						<td><code>name, permissions</code></td>
						<td><code>&#123;name, permissions&#125;</code></td>
					</tr>
					<tr>
						<td class="method">
							<span class="verb PATCH">PATCH</span><code>
								/<wbr />api/<wbr />v1/<wbr />admin/<wbr />roles/<wbr />definition
							</code>
						</td>
						<td>Administrator or Owner</td>
						<td><code>name, permissions</code></td>
						<td><code>&#123;name, permissions&#125;</code></td>
					</tr>
					<tr>
						<td class="method">
							<span class="verb DELETE">DELETE</span><code>
								/<wbr />api/<wbr />v1/<wbr />admin/<wbr />roles/<wbr />definition
							</code>
						</td>
						<td>Administrator or Owner</td>
						<td><code>name</code></td>
						<td><code>&#123;&#125;</code></td>
					</tr>
					<tr>
						<td class="method">
							<span class="verb GET">GET</span><code>
								/<wbr />api/<wbr />v1/<wbr />admin/<wbr />audit
							</code>
						</td>
						<td><code>viewAdmin</code></td>
						<td>
							Query <code>before?</code> audit ID, <code>actorId?</code>, <code>prefix?</code> event namespace
						</td>
						<td><code>&#123;events, next&#125;</code></td>
					</tr>
					<tr>
						<td class="method">
							<span class="verb GET">GET</span><code>
								/<wbr />api/<wbr />v1/<wbr />admin/<wbr />preferences
							</code>
						</td>
						<td><code>manageSettings</code></td>
						<td>—</td>
						<td>Server preferences and allowed default roles</td>
					</tr>
					<tr>
						<td class="method">
							<span class="verb PATCH">PATCH</span><code>
								/<wbr />api/<wbr />v1/<wbr />admin/<wbr />preferences
							</code>
						</td>
						<td><code>manageSettings</code></td>
						<td>
							<code>motd?, defaultRole?, defaultAudioBitrate?, maxAttachmentMiB?</code>
						</td>
						<td>Updated server preferences</td>
					</tr>
					<tr>
						<td class="method">
							<span class="verb POST">POST</span><code>
								/<wbr />api/<wbr />v1/<wbr />admin/<wbr />invitations
							</code>
						</td>
						<td><code>manageInvitations</code></td>
						<td><code>expiresAt?, expiresInSeconds?, uses?</code></td>
						<td><code>id, token, expiresAt, usesLeft</code></td>
					</tr>
					<tr>
						<td class="method">
							<span class="verb GET">GET</span><code>
								/<wbr />api/<wbr />v1/<wbr />admin/<wbr />invitations
							</code>
						</td>
						<td><code>manageInvitations</code></td>
						<td>—</td>
						<td><code>invitations</code> with non-deleted records</td>
					</tr>
					<tr>
						<td class="method">
							<span class="verb PATCH">PATCH</span><code>
								/<wbr />api/<wbr />v1/<wbr />admin/<wbr />invitations/<wbr />:id
							</code>
						</td>
						<td><code>manageInvitations</code></td>
						<td><code>expiresAt?, usesLeft?</code></td>
						<td>Updated invitation record</td>
					</tr>
					<tr>
						<td class="method">
							<span class="verb DELETE">DELETE</span><code>
								/<wbr />api/<wbr />v1/<wbr />admin/<wbr />invitations/<wbr />:id
							</code>
						</td>
						<td><code>manageInvitations</code></td>
						<td>—</td>
						<td><code>&#123;&#125;</code></td>
					</tr>
					<tr>
						<td class="method">
							<span class="verb PATCH">PATCH</span><code>
								/<wbr />api/<wbr />v1/<wbr />admin/<wbr />banner
							</code>
						</td>
						<td><code>manageSettings</code></td>
						<td>
							<code>bannerImageUrl</code> as an HTTPS URL (from <code>server.image_hosts</code> when
							set) or <code>null</code>
						</td>
						<td><code>&#123;bannerImageUrl&#125;</code></td>
					</tr>
					<tr>
						<td class="method">
							<span class="verb PATCH">PATCH</span><code>
								/<wbr />api/<wbr />v1/<wbr />channels/<wbr />order
							</code>
						</td>
						<td><code>editChannels</code></td>
						<td>
							<code>channelId, targetId, placement</code> as <code>before</code>,
							<code>after</code>, or <code>inside</code>, with optional <code>parentId</code>
						</td>
						<td><code>&#123;&#125;</code></td>
					</tr>
					<tr>
						<td class="method">
							<span class="verb GET">GET</span><code>
								/<wbr />api/<wbr />v1/<wbr />admin/<wbr />password
							</code>
						</td>
						<td><code>manageSettings</code></td>
						<td>—</td>
						<td><code>&#123;passwordRequired, passwordLocked&#125;</code></td>
					</tr>
					<tr>
						<td class="method">
							<span class="verb PATCH">PATCH</span><code>
								/<wbr />api/<wbr />v1/<wbr />admin/<wbr />password
							</code>
						</td>
						<td><code>manageSettings</code> when <code>VOICE_SERVER_PASSWORD</code> is unset</td>
						<td><code>password</code> or <code>null</code> to remove it</td>
						<td><code>&#123;passwordRequired&#125;</code></td>
					</tr>
				</tbody>
			</table>
		</div>

		<h3 id="accounts-and-sessions">
			<a href="#accounts-and-sessions" class="heading-link">Accounts and sessions</a>
		</h3>
		<p>
			An Account object has <code>id, displayName, role, createdAt, badge</code>. Session responses
			have <code>sessionId, accessToken, refreshToken, accessExpiresAt, refreshExpiresAt</code> at
			the top level alongside <code>account</code> for sign-in and account creation. Session
			listings contain no token values. The capability response supplies ICE server settings only to
			authenticated callers. Native requests may omit the Origin header. Cross-origin browser
			requests require an exact match in <code>server.origins</code>.
		</p>
		<h3 id="server-administration">
			<a href="#server-administration" class="heading-link">Server administration</a>
		</h3>
		<p>
			Servers advertising <code>extendedServerAdministration</code> support server preferences, role
			deletion, and HTTP audit history. Audit events are returned newest first, with up to 100
			entries. Pass <code>next</code> as <code>before</code> to continue with the same filters.
			Entries include
			<code>id, action, createdAt, actorId, actorName, targetId, targetName, details</code>. The log
			records account activity, connections, channel membership, moderation, and administrative
			changes. It stores event metadata, excluding credentials, message contents, and voice data.
		</p>
		<p>
			Preferences apply live. Set <code>motd</code> to an empty string to clear the message. Set
			<code>defaultAudioBitrate</code> to null to use the configured server value. The
			<code>VOICE_MEDIA_TARGET_AUDIO_BITRATE</code> environment variable locks that default.
			Changing
			<code>defaultRole</code> also requires <code>manageRoles</code> and affects new registrations.
			Guest, Member, and custom roles are eligible if their server grants and channel allows are
			within
			<code>registrationPermissions</code>. The current registration role can receive grants only
			within that list. A custom role can be deleted after it is unassigned from all accounts and
			replaced as the default, if selected.
		</p>
		<p>
			Administrators and the Owner can update the grants for Guest, Member, Moderator, and custom
			roles through <code>PATCH /api/v1/admin/roles/definition</code>. Each
			<code>builtInRoles</code>
			entry has <code>name, permissions, editable, defaultPermissions</code>. Role grants apply to
			connected accounts immediately and trigger <code>state.invalidated</code>.
		</p>
		<p>
			Role changes require the actor to rank above both the account’s current role and its new role
			and to hold both roles’ server-wide and effective channel permissions. Editing or deleting a
			role requires a higher rank and the role’s existing grants. New role grants must stay within
			the actor’s permissions at every scope where they apply. Custom roles share a rank between
			Moderator and Administrator. Channel ordering requires permission to see and edit both
			channels.
			<code>inside</code> appends the moved channel and its subtree to the target's children.
			<code>before</code> and <code>after</code> order siblings. To use either across levels, send
			the target's <code>parentId</code>, using <code>null</code> for the top level. A move to a new
			parent also requires permission to see and edit that parent. Invitation expiration can use
			either a future Unix timestamp in milliseconds or a lifetime in seconds. Omitting both leaves
			the invitation without an expiration. Omitting <code>uses</code> allows unlimited
			registrations. Invitation updates leave omitted fields as they are and use <code>null</code>
			to remove an expiry or use limit. Setting <code>usesLeft</code> replaces the number of
			remaining uses. Invitation listings and update responses contain metadata only. When
			<code>invitationPasswordBypass</code> is advertised, a valid invite satisfies the shared
			password requirement for account creation. An account created with an invitation can later
			sign in using proof of the same identity. Invitation expiry, deletion, and use limits apply to
			new registrations. The server password is read-only in the API when the host sets
			<code>VOICE_SERVER_PASSWORD</code>.
		</p>
		<h3 id="signing-in-with-an-identity">
			<a href="#signing-in-with-an-identity" class="heading-link">Signing in with an identity</a>
		</h3>
		<p>
			For <code>login</code>, <code>register</code>, or <code>bootstrap</code>, request a challenge
			for the raw 32-byte Ed25519 public key encoded in base64url without padding. Verify the
			returned server ID, origin, operation, key, device name, and empty binding. Sign the UTF-8
			bytes of the compact JSON array below with the private key. <code>id</code> is the challenge
			nonce and
			<code>expiresAt</code> is in Unix milliseconds.
		</p>
		<CodeBlock
			lang="json"
			label="Signature payload"
			code={`["korero-identity-v1", serverId, origin, operation, id, publicKey, "", deviceName, expiresAt]`}
		/>
		<p>
			Encode the signature as base64url without padding. Send <code>&#123;id, signature&#125;</code>
			to the login endpoint or as <code>identity</code> in the enrollment request. A valid login
			proof for an unregistered key returns <code>NOT_FOUND</code>.
		</p>

		<h2 id="websocket">
			<a href="#websocket" class="heading-link">WebSocket connection and envelopes</a>
		</h2>
		<ol class="steps">
			<li>Check that discovery lists v1. Obtain a fresh ticket through the HTTP API.</li>
			<li>
				Open <code>wss://&lt;host&gt;:&lt;port&gt;/api/v1/ws</code> with the same certificate trust decision.
			</li>
			<li>
				Within five seconds send the authentication request. The outer version identifies the
				handshake format and <code>versions</code> lists the versions the client can use.
			</li>
			<li>
				On success the response contains an authoritative snapshot. Join a channel explicitly. Send
				<code>heartbeat</code> every 25 seconds, or keep the connection active with other requests. The
				idle timeout is 60 seconds.
			</li>
			<li>
				After disconnect, obtain a new ticket, reconnect, join again, and recreate media.
				<code>state.get</code> recovers a snapshot whenever an event is missed or state is invalidated.
			</li>
		</ol>
		<CodeBlock
			lang="json"
			label="connection.authenticate"
			code={`{"version":1,"id":1,"type":"connection.authenticate","payload":{"ticket":"<43-character token>","versions":[1]}}`}
		/>
		<CodeBlock
			lang="json"
			label="channel.join"
			code={`{"version":1,"id":2,"type":"channel.join","payload":{"channelId":"00000000-0000-4000-8000-000000000001"}}`}
		/>
		<CodeBlock
			lang="json"
			label="Failed response"
			code={`{"version":1,"id":2,"type":"response","success":false,"error":{"code":"FORBIDDEN","message":"Operation not permitted"}}`}
		/>
		<CodeBlock
			lang="json"
			label="Successful response"
			code={`{"version":1,"id":3,"type":"response","success":true,"payload":{}}`}
		/>
		<CodeBlock
			lang="json"
			label="Event"
			code={`{"version":1,"type":"channel.changed","payload":{"channelId":null}}`}
		/>
		<h3 id="request-ids-and-retries">
			<a href="#request-ids-and-retries" class="heading-link">Request IDs and retries</a>
		</h3>
		<p>
			Requests use strictly increasing positive integers up to JavaScript's safe-integer maximum,
			with a fresh sequence on reconnect. One connection executes requests in order. Retransmitting
			an identical retained request ID and JSON object returns the cached response. Keep member
			ordering and serialization stable for retries. The server caches up to 16 completed, validly
			framed requests within a 256 KiB response budget. A changed or forgotten ID at or below the
			high-water mark returns <code>CONFLICT</code>. A malformed envelope without a usable ID
			receives an error with ID zero if the socket remains writable. A reconnect does not replay
			mutations. Reconcile state before retrying operations across connections.
		</p>
		<h3 id="the-connection-snapshot">
			<a href="#the-connection-snapshot" class="heading-link">The connection snapshot</a>
		</h3>
		<p>
			A successful snapshot has <code>
				connectionId, account, channelId, channels, totalUsers, presence, members,
				serverPermissions, lowerRoles, assignableRoles, bannerImageUrl, canReorderChannels
			</code>. <code>totalUsers</code> counts registered accounts, including offline accounts. Each
			presence entry represents one online account, even when that account has multiple connected
			devices. Extended administration adds <code>motd</code> and the effective server
			<code>targetAudioBitrate</code> in bits per second. Changes to either value trigger
			<code>state.invalidated</code>. <code>lowerRoles</code> lists roles below the caller in the
			server hierarchy. <code>assignableRoles</code> lists roles the caller can assign to a
			subordinate account. The channel list has
			<code>
				id, parentId, name, description, position, capacity, temporary, passwordRequired, canChat,
				canAttachFiles, canMute, canReparent, canDelete
			</code>. <code>canChat</code> indicates whether the caller can read and send messages in that
			channel. <code>canAttachFiles</code> also requires the <code>attachFiles</code> permission. On
			older servers that omit <code>canChat</code>, clients use chat in the joined channel only.
			Invisible parents are represented as null. Members have
			<code>
				connectionId, accountId, displayName, role, badge, muted, deafened, adminMuted,
				adminDeafened
			</code>
			and cover the socket's current channel. Presence entries have
			<code>accountId, displayName, connections</code>. On servers with
			<code>profilePictures</code>, accounts and presence entries include a nullable
			<code>avatarId</code> revision. Profile pictures are limited to 192 KiB and 192 pixels per side.
			Updating a picture refreshes the account's presence and invalidates its active sessions' snapshots.
		</p>
		<p>
			Badges are cosmetic text labels of up to 32 characters. The badge endpoint accepts
			<code>null</code> to clear a badge. It only allows edits to other accounts below the caller's role,
			and records changes in the audit log.
		</p>
		<h3 id="closing-and-limits">
			<a href="#closing-and-limits" class="heading-link">Closing and limits</a>
		</h3>
		<p>
			Oversized frames, a full pending request queue or outbound backpressure may close the socket.
			Ticket renewal can extend a session without tearing down media.
		</p>
		<div class="table-wrap">
			<table class="close-table">
				<thead>
					<tr><th>Close code</th><th>Meaning</th><th>What to do</th></tr>
				</thead>
				<tbody>
					<tr>
						<td><code>4401</code></td>
						<td>Authentication expired, or the device was revoked</td>
						<td>
							Get a new ticket and reconnect. A revoked device’s transports are already closed.
						</td>
					</tr>
					<tr>
						<td><code>4403</code></td>
						<td>Kicked</td>
						<td>
							Wait 60 seconds. Until then <code>connection.authenticate</code> returns
							<code>FORBIDDEN</code>.
						</td>
					</tr>
					<tr>
						<td><code>4429</code></td>
						<td>A limit was reached</td>
						<td>Back off before reconnecting.</td>
					</tr>
				</tbody>
			</table>
		</div>

		<h2 id="requests"><a href="#requests" class="heading-link">Application requests</a></h2>
		<p>
			Use <code>&#123;&#125;</code> for an empty payload. Optional fields are indicated by
			<code>?</code>. Omitted edit fields retain their value. <code>null</code> clears nullable parent,
			capacity, password or permission-override fields.
		</p>
		<div class="table-wrap">
			<table class="request-table">
				<thead>
					<tr><th>Type</th><th>Payload fields</th><th>Success payload</th></tr>
				</thead>
				<tbody>
					<tr>
						<td><code>connection.renew</code></td>
						<td><code>ticket</code> for the same device</td>
						<td><code>&#123;expiresAt&#125;</code></td>
					</tr>
					<tr>
						<td><code>heartbeat</code></td><td>—</td><td>
							<code>&#123;time, sessionExpiresAt&#125;</code>
						</td>
					</tr>
					<tr><td><code>state.get</code></td><td>—</td><td>Snapshot</td></tr>
					<tr>
						<td><code>channel.create</code></td>
						<td>
							<code>
								name, description?, parentId?, position?, capacity?, password?, backgroundImageUrl?,
								icon?, audioBitrate?, temporary?
							</code>
						</td>
						<td><code>&#123;channelId, state&#125;</code></td>
					</tr>
					<tr>
						<td><code>channel.edit</code></td>
						<td>
							<code>channelId</code> and editable creation fields other than <code>temporary</code>
						</td>
						<td><code>&#123;channelId, state&#125;</code></td>
					</tr>
					<tr>
						<td><code>channel.delete</code></td><td><code>channelId</code></td><td>
							<code>&#123;&#125;</code>
						</td>
					</tr>
					<tr>
						<td><code>channel.join</code></td>
						<td><code>channelId, password?</code></td>
						<td>Snapshot</td>
					</tr>
					<tr><td><code>channel.leave</code></td><td>—</td><td>Snapshot</td></tr>
					<tr>
						<td><code>channel.view</code></td>
						<td><code>channelId</code> or <code>null</code> to stop following</td>
						<td><code>&#123;&#125;</code></td>
					</tr>
					<tr>
						<td><code>channel.move</code></td>
						<td><code>connectionId, channelId</code></td>
						<td><code>&#123;&#125;</code></td>
					</tr>
					<tr>
						<td><code>presence.set</code></td>
						<td><code>muted?, deafened?, afk?, afkMessage?</code></td>
						<td>Member</td>
					</tr>
					<tr>
						<td><code>role.set</code></td>
						<td><code>accountId, role</code></td>
						<td><code>&#123;&#125;</code></td>
					</tr>
					<tr>
						<td><code>channel.override</code></td>
						<td><code>channelId, role, permission, allow</code></td>
						<td><code>&#123;&#125;</code></td>
					</tr>
					<tr>
						<td><code>moderation.mute</code></td>
						<td><code>connectionId, muted</code></td>
						<td><code>&#123;&#125;</code></td>
					</tr>
					<tr>
						<td><code>moderation.deafen</code></td>
						<td><code>connectionId, deafened</code></td>
						<td><code>&#123;&#125;</code></td>
					</tr>
					<tr>
						<td><code>moderation.kick</code></td><td><code>accountId</code></td><td>
							<code>&#123;&#125;</code>
						</td>
					</tr>
					<tr>
						<td><code>moderation.ban</code></td>
						<td><code>accountId, expiresInSeconds?</code></td>
						<td><code>&#123;&#125;</code></td>
					</tr>
					<tr>
						<td><code>moderation.unban</code></td><td><code>accountId</code></td><td>
							<code>&#123;&#125;</code>
						</td>
					</tr>
					<tr>
						<td><code>invitation.create</code></td>
						<td><code>expiresAt?, expiresInSeconds?, uses?</code></td>
						<td><code>&#123;id, token, expiresAt, usesLeft&#125;</code></td>
					</tr>
					<tr>
						<td><code>invitation.list</code></td>
						<td>—</td>
						<td>Latest 100 invitation records without tokens or verifiers</td>
					</tr>
					<tr>
						<td><code>invitation.update</code></td>
						<td><code>invitationId, expiresAt?, usesLeft?</code></td>
						<td>Updated invitation record</td>
					</tr>
					<tr>
						<td><code>invitation.revoke</code></td>
						<td><code>invitationId</code></td>
						<td><code>&#123;&#125;</code></td>
					</tr>
					<tr>
						<td><code>server.settings</code></td><td><code>name?</code></td><td>
							<code>&#123;&#125;</code>
						</td>
					</tr>
					<tr>
						<td><code>admin.diagnostics</code></td>
						<td>—</td>
						<td>
							Counts, process CPU and memory, worker PID and native resource usage where available
						</td>
					</tr>
					<tr>
						<td><code>admin.audit</code></td>
						<td><code>before?</code> audit ID</td>
						<td>Latest 100 matching audit records</td>
					</tr>
					<tr>
						<td><code>message.send</code></td>
						<td><code>channelId, text, html?</code></td>
						<td><code>&#123;messageId&#125;</code></td>
					</tr>
					<tr>
						<td><code>message.history</code></td>
						<td><code>channelId</code> and optional <code>before</code> timestamp</td>
						<td>Up to 100 channel messages in descending time order</td>
					</tr>
					<tr>
						<td><code>message.delete</code></td>
						<td><code>messageId</code></td>
						<td><code>&#123;&#125;</code></td>
					</tr>
					<tr>
						<td><code>direct.peer</code></td>
						<td><code>accountId</code></td>
						<td><code>accountId, displayName, publicKey, ownPublicKey</code></td>
					</tr>
					<tr>
						<td><code>direct.inbox</code></td>
						<td>—</td>
						<td>
							Up to 50 recent contacts with <code>accountId, displayName, lastMessageAt</code>
						</td>
					</tr>
					<tr>
						<td><code>direct.history</code></td>
						<td><code>accountId, before?: &#123;createdAt, id&#125;</code></td>
						<td><code>&#123;messages, next&#125;</code></td>
					</tr>
					<tr>
						<td><code>direct.send</code></td>
						<td><code>accountId, id, nonce, ciphertext, signature</code></td>
						<td><code>&#123;messageId&#125;</code></td>
					</tr>
					<tr>
						<td><code>direct.poke</code></td>
						<td><code>accountId, message?</code></td>
						<td><code>&#123;&#125;</code></td>
					</tr>
				</tbody>
			</table>
		</div>
		<h3 id="channel-permissions">
			<a href="#channel-permissions" class="heading-link">Channel permissions</a>
		</h3>
		<p>
			<code>channel.override</code> requires <code>manageRoles</code>, server-wide
			<code>editChannels</code>, and the permission being changed at server scope. The actor must
			also rank above the target role and hold its server-wide grants. In the target channel and
			every descendant whose effective permission changes, the actor needs <code>join</code>,
			<code>editChannels</code>, the permission being changed, and the target role’s effective
			channel permissions.
		</p>
		<p>
			<code>channel.delete</code> requires the effective <code>removeChannels</code> permission. The
			Lobby and channels with children cannot be deleted. Deleting another member’s channel message
			still requires <code>deleteChannels</code>.
		</p>
		<h3 id="moderation-history-and-files">
			<a href="#moderation-history-and-files" class="heading-link">Moderation, history and files</a>
		</h3>
		<p>
			Registration and <code>server.max_users</code> are host-only settings: change them in TOML or
			with <code>VOICE_SERVER_REGISTRATION</code> / <code>VOICE_SERVER_MAX_USERS</code>, not through
			<code>server.settings</code>. Server mute and deafen require <code>mute</code> at server scope and
			in the target channel. They apply to a subordinate account identified by its connection ID and persist
			across connections. Server mute blocks producers. Server deafen blocks producers and consumers independently
			of self-deafen. Enabling either restriction closes affected media resources. Clients recreate producers
			or consumers once allowed. Kicking closes all account connections. Banning also revokes all device
			sessions. Temporary rooms are joined on creation and disappear when empty.
		</p>
		<p>
			With <code>join</code> and <code>text</code> permission, a connection can read and send
			messages without joining the channel. Password-protected channels require membership. A
			connection receives live chat events for its joined channel and can use
			<code>channel.view</code>
			to follow one additional channel. A new <code>channel.view</code> replaces the previous one.
			The server sends <code>channel.viewEnded</code> if the connection loses chat access to the
			followed channel. Send <code>channel.view</code> again once <code>canChat</code> is true. Subscribe
			before requesting history to receive live messages during the request. History is empty when text
			persistence is disabled. Current live text still works.
		</p>
		<p>
			Message objects contain <code>id, channelId, recipientId, senderId, createdAt, text</code> and
			may include <code>html</code> and attachment metadata as
			<code>attachment: &#123;name, size&#125;</code>. When server info advertises
			<code>richChat</code>, clients may send an optional
			<code>html</code> representation of the same content, up to 32,768 characters. The server
			strips markup outside the formatting allowlist (<code>
				p, br, strong, b, em, i, u, s, del, code, pre, blockquote, ul, ol, li, a
			</code>, with <code>href</code> on links to <code>http(s)</code> URLs and <code>start</code>
			on ordered lists) before storing or relaying it. Keep <code>text</code> as the plain-text
			representation. <code>maxWebSocketBytes</code> caps the UTF-8 request envelope. Treat received
			markup as untrusted and render it only after sanitizing it against a strict formatting
			allowlist, or display <code>text</code>. Channel message objects have a null
			<code>recipientId</code>. An attachment is sent as one channel message with an optional
			caption. Use standard padded base64 for <code>data</code>. Server info and connection
			snapshots advertise the current decoded file limit as <code>maxAttachmentBytes</code>.
			Administrators can set
			<code>maxAttachmentMiB</code> from 1 to 32 in <code>PATCH /api/v1/admin/preferences</code>.
			The default is 4 MiB. Uploads and downloads require chat access to the message's channel.
			Uploads also require <code>attachFiles</code> permission, reflected by the channel's
			<code>canAttachFiles</code> field. The snapshot's top-level <code>canAttachFiles</code> field
			covers the joined channel. Downloads return encoded data separately from history and events.
			Persistent attachments expire and are deleted with their message. In-memory attachments are
			available for up to one hour. The in-memory quotas are 8 MiB per sender and 32 MiB per server
			by default. A higher file limit raises those caps to at least one file per sender and four
			files per server. Persistent storage is limited to 32 MiB per sender and 256 MiB per server.
			By default each account has a download budget of 240 requests and 128 MiB of decoded file
			data, refilled over one minute, and uploads are capped at 120 requests per minute. Hosts can
			adjust these with
			<code>limits.attachment_downloads_per_minute</code>,
			<code>limits.attachment_download_bytes_per_minute</code> and
			<code>limits.attachment_uploads_per_minute</code>.
		</p>
		<h3 id="afk"><a href="#afk" class="heading-link">AFK</a></h3>
		<p>
			AFK is connection-scoped. While <code>afk</code> is true, both <code>muted</code> and
			<code>deafened</code> are reported as true and the server closes and blocks producers and
			consumers for that connection. Setting <code>afk</code> to false restores its self-mute and
			self-deafen settings. Channel members include <code>afk</code> and <code>afkMessage</code> in snapshots
			and member events. Messages are single lines of up to 120 characters and are shared while AFK. An
			empty string clears the message.
		</p>

		<h2 id="direct"><a href="#direct" class="heading-link">Encrypted direct messages</a></h2>
		<p>
			Snapshots advertise <code>
				directMessages: &#123;maxBytes, persistent, offlineDelivery, canSend&#125;
			</code>. Both accounts live on the same server. Clients keep a connection to each saved
			server, so a direct message reaches the recipient on that server regardless of which server
			they are viewing. Sending requires server-level <code>sendDirectMessages</code> permission and
			a recipient with an enrolled identity. The server derives the sender from the authenticated
			socket and delivers <code>direct.created</code> to both accounts’ active devices. Packets
			include
			<code>id, senderId, recipientId, createdAt, nonce, ciphertext, signature</code>. The server
			supplies <code>createdAt</code> and uses it for retention and history order.
		</p>
		<h3 id="offline-delivery">
			<a href="#offline-delivery" class="heading-link">Offline delivery</a>
		</h3>
		<p>
			The recipient can be offline when the server accepts a packet. <code>direct.send</code>
			returns
			<code>&#123;messageId, queued&#125;</code>, where <code>queued</code> is true when no
			recipient device was connected. The server holds a queued packet until a recipient device
			fetches it with
			<code>direct.pending</code>, which returns up to 100 of the oldest undelivered packets
			addressed to the caller, oldest first, each with the sender's current <code>senderName</code>.
			The client then sends <code>direct.ack</code> with <code>&#123;ids&#125;</code> (1 to 100
			packet IDs). Repeat until <code>direct.pending</code> returns an empty list. Clients call
			<code>direct.pending</code>
			after each successful <code>connection.authenticate</code>. Acknowledging an unknown or
			already delivered ID has no effect. A recipient holds at most
			<code>messaging.offline_delivery_queue</code> undelivered packets, of which one sender may
			hold at most <code>messaging.offline_delivery_per_sender</code>. Further offline sends return
			<code>LIMIT</code>. The sender can retry an identical packet using the same ID.
		</p>
		<h3 id="history-and-retention">
			<a href="#history-and-retention" class="heading-link">History and retention</a>
		</h3>
		<p>
			With <code>persistent</code> enabled, delivered packets stay in history until the
			<code>messaging.retention_hours</code> cutoff, and undelivered packets follow the same cutoff.
			History returns up to 10 packets newest first, breaking ties by ID. Pass the returned
			<code>next</code> as <code>before</code> to load another page. With persistence disabled,
			inbox and history are empty. The server deletes each queued packet when a recipient device
			acknowledges it, or after <code>messaging.offline_delivery_hours</code>. A packet delivered to
			a connected device is not stored. The encrypted requests are separate from channel chat. The
			server rejects legacy plaintext direct-message sends.
		</p>
		<h3 id="pokes"><a href="#pokes" class="heading-link">Pokes</a></h3>
		<p>
			Snapshots advertise poke support through <code>pokeMaxLength</code>. A poke requires
			<code>sendDirectMessages</code> permission and an active recipient on the same server. The
			server delivers <code>direct.poked</code> to the recipient's active devices immediately. The optional
			single-line note travels as text over the WebSocket and is not stored in direct message history.
			Pokes have a separate rate limit of six per minute per account.
		</p>
		<h3 id="safety-codes"><a href="#safety-codes" class="heading-link">Safety codes</a></h3>
		<p>
			Clients check that <code>ownPublicKey</code> matches their enrolled identity and verify the
			conversation safety code out of band before sending or decrypting. Compute the code as the
			first 16 bytes of SHA-256, rendered as hex, over the UTF-8 compact JSON array
			<code>["korero-direct-safety-code-v1", serverId, participants]</code>. Each participant is
			<code>[accountId, publicKey]</code> and the two entries sort by account ID. Pin the verified code
			locally and refuse a changed value.
		</p>
		<h3 id="encrypting-a-message">
			<a href="#encrypting-a-message" class="heading-link">Encrypting a message</a>
		</h3>
		<ol class="steps">
			<li>
				Convert the local Ed25519 seed and the peer’s validated Ed25519 public key to X25519 with a
				standard implementation. Reject small-order and non-prime-order peer points and an all-zero
				shared secret.
			</li>
			<li>
				Generate a random UUIDv4 <code>id</code> and a random 12-byte nonce for each message.
			</li>
			<li>
				Derive a 32-byte AES key from the shared secret using HKDF-SHA-256 with a 32-byte zero salt
				and the UTF-8 compact JSON array
				<code>["korero-direct-message-v1", serverId, senderId, recipientId, id]</code> as the information
				parameter.
			</li>
			<li>
				Encrypt 1 to <code>maxBytes</code> of UTF-8 text with AES-256-GCM, using the same array as associated
				data, and append the 16-byte authentication tag. Encode the nonce and tagged ciphertext as unpadded
				base64url.
			</li>
			<li>
				Extend the associated-data array with the two encoded strings in that order, sign its UTF-8
				compact JSON with Ed25519 and encode that signature as unpadded base64url.
			</li>
		</ol>
		<p>
			Recipients verify the signature against the pinned sender identity and authenticate the
			ciphertext before displaying text.
		</p>

		<h2 id="webrtc"><a href="#webrtc" class="heading-link">WebRTC negotiation</a></h2>
		<p>
			Use the object field names and types from the
			<a href="https://mediasoup.org/documentation/v3/mediasoup/rtp-parameters-and-capabilities/">
				mediasoup v3 RTP reference
			</a>
			and <a href="https://mediasoup.org/documentation/v3/mediasoup/api/">transport API</a>. A
			client must join first, load the router RTP capabilities, then negotiate its send and receive
			transports separately. Media operations use membership and ownership scope. Client-supplied
			account IDs never establish media ownership.
		</p>
		<div class="table-wrap">
			<table class="media-table">
				<thead>
					<tr><th>Type</th><th>Payload fields</th><th>Success payload</th></tr>
				</thead>
				<tbody>
					<tr>
						<td><code>media.capabilities</code></td>
						<td><code>kind?: "video"</code></td>
						<td>Router RTP capabilities, plus <code>iceServers</code> for video</td>
					</tr>
					<tr>
						<td><code>media.transport.create</code></td>
						<td>
							<code>direction</code> (<code>send</code> or <code>receive</code>),
							<code>forceTcp?</code>, <code>kind?: "video"</code>,
							<code>videoSource?: "camera"</code>, <code>whisperChannelId?</code>,
							<code>whisperPassword?</code>
						</td>
						<td>
							<code>&#123;id, iceCandidates, iceParameters, dtlsParameters&#125;</code>
						</td>
					</tr>
					<tr>
						<td><code>media.transport.connect</code></td>
						<td><code>transportId, dtlsParameters</code></td>
						<td><code>&#123;&#125;</code></td>
					</tr>
					<tr>
						<td><code>media.transport.close</code></td>
						<td><code>transportId</code></td>
						<td><code>&#123;&#125;</code></td>
					</tr>
					<tr>
						<td><code>media.transport.stats</code></td>
						<td><code>transportId</code></td>
						<td>mediasoup WebRTC transport stats array</td>
					</tr>
					<tr>
						<td><code>media.ice.restart</code></td>
						<td><code>transportId</code></td>
						<td>New ICE parameters</td>
					</tr>
					<tr>
						<td><code>media.producers</code></td>
						<td>—</td>
						<td>Array of accessible <code>producerId, connectionId, paused, speaking</code></td>
					</tr>
					<tr>
						<td><code>media.producer.create</code></td>
						<td>
							<code>transportId, kind, rtpParameters</code> with kind <code>audio</code> or
							<code>video</code>
						</td>
						<td><code>&#123;id&#125;</code></td>
					</tr>
					<tr>
						<td><code>media.producer.pause</code>, <code>resume</code>, <code>close</code></td>
						<td><code>producerId</code></td>
						<td><code>&#123;&#125;</code></td>
					</tr>
					<tr>
						<td><code>media.consumer.create</code></td>
						<td><code>transportId, producerId, rtpCapabilities</code></td>
						<td>
							<code>
								&#123;id, producerId, accountId, kind, rtpParameters, producerPaused&#125;
							</code>
						</td>
					</tr>
					<tr>
						<td><code>media.consumer.pause</code>, <code>resume</code>, <code>close</code></td>
						<td><code>consumerId</code></td>
						<td><code>&#123;&#125;</code></td>
					</tr>
				</tbody>
			</table>
		</div>
		<h3 id="transport-flow"><a href="#transport-flow" class="heading-link">Transport flow</a></h3>
		<p>
			On the sending side, route the WebRTC transport's DTLS connect and produce callbacks through
			their respective requests. On the receiving side, create the consumer on the server, add the
			matching WebRTC consumer locally, then send <code>media.consumer.resume</code>. For late
			joins, query <code>media.producers</code> before consuming. For ICE restart, apply the returned
			ICE parameters through the client transport. If the worker resets or the client changes rooms, discard
			stale media IDs and transports.
		</p>
		<h3 id="voice"><a href="#voice" class="heading-link">Voice</a></h3>
		<p>
			Voice uses Opus at 48 kHz. SDP advertises Opus with two-channel capability as required for
			interop. Clients default to mono capture and can negotiate stereo, DTX, FEC and a target 20 ms
			packetization interval where supported. The advertised target bitrate defaults to 64 kbit/s. A
			channel's <code>audioBitrate</code> can override the server default with a value from 32000 to
			128000 bits per second. Setting it requires <code>manageSettings</code> and the applicable
			channel editing permissions. Use <code>null</code> to inherit the server default. Use the effective
			bitrate in the sender's Opus codec options. Actual throughput depends on the encoder and network.
		</p>
		<h3 id="screen-sharing"><a href="#screen-sharing" class="heading-link">Screen sharing</a></h3>
		<p>
			Servers advertising <code>screenSharing</code> support a separate screen transport in each
			direction. Publishing requires <code>speak</code> and <code>shareScreen</code> in the joined
			channel, reflected by the snapshot's <code>canShareScreen</code> field. Screen sharing uses
			VP8 and can include one Opus source-audio track. Publish optional source audio before
			publishing video. Discover both IDs in the snapshot's <code>screens</code> array or through
			<code>media.screenAvailable</code>. A repeat event for the same video producer updates its
			audio ID. Consuming screen media requires a screen receive transport.
			<code>media.producers</code> lists microphone audio.
		</p>
		<h3 id="whisper"><a href="#whisper" class="heading-link">Whisper</a></h3>
		<p>
			A microphone send transport can set <code>whisperChannelId</code> to route only to a different
			occupied channel. The sender stays joined to their source channel. Close the normal microphone
			send transport before requesting a whisper transport. The sender needs <code>speak</code> and
			<code>whisper</code> in both channels and <code>join</code> in the destination. Supply
			<code>whisperPassword</code> when the destination has a password. The destination password and
			both channels' permissions are rechecked during the route lifetime. The destination receives
			the usual microphone producer events with <code>whisperFrom</code> on
			<code>media.producerAvailable</code>. Its snapshot lists the current whispers as
			<code>&#123;producerId, from&#125;</code>. Read-only views of other rooms omit that list. The
			transport closes when the sender leaves or is muted, deafened or AFK, or when the destination
			empties or becomes inaccessible. <code>media.whisperEnded</code> reports the source
			<code>channelId</code> and closed <code>transportId</code> to the sender.
		</p>
		<h3 id="camera"><a href="#camera" class="heading-link">Camera</a></h3>
		<p>
			An array in the snapshot's <code>cameras</code> field indicates webcam support. For camera
			send and receive transports use <code>kind: "video"</code> with
			<code>videoSource: "camera"</code>. Camera transports carry VP8 video at up to 6 Mbit/s. They
			are separate from screen transports, which continue to use the default video source. A camera
			produces one video track and requires
			<code>speak</code> and <code>useCamera</code> in the joined channel, reflected by the
			snapshot's
			<code>canUseCamera</code> field. Self-mute affects microphone voice while camera video stays
			on. Discover camera producers in <code>cameras</code> or through
			<code>media.cameraAvailable</code>.
		</p>

		<h2 id="events"><a href="#events" class="heading-link">Events</a></h2>
		<div class="table-wrap">
			<table class="event-table">
				<thead>
					<tr><th>Event</th><th>Payload</th></tr>
				</thead>
				<tbody>
					<tr>
						<td><code>presence.changed</code></td>
						<td><code>accountId, displayName, connections</code></td>
					</tr>
					<tr><td><code>presence.offline</code></td><td><code>accountId</code></td></tr>
					<tr>
						<td><code>channel.userJoined</code>, <code>channel.userChanged</code></td>
						<td><code>channelId</code> and Member fields</td>
					</tr>
					<tr>
						<td><code>channel.userLeft</code></td>
						<td><code>channelId, connectionId, accountId</code></td>
					</tr>
					<tr>
						<td><code>channel.changed</code></td>
						<td><code>channelId</code> or null for a move or removal by the server</td>
					</tr>
					<tr>
						<td><code>channel.viewEnded</code></td>
						<td><code>channelId</code> when the server ends a chat subscription</td>
					</tr>
					<tr>
						<td><code>state.invalidated</code></td>
						<td><code>&#123;&#125;</code>, re-fetch snapshot</td>
					</tr>
					<tr><td><code>server.changed</code></td><td><code>name, registration</code></td></tr>
					<tr><td><code>message.created</code></td><td>Message</td></tr>
					<tr>
						<td><code>message.edited</code></td>
						<td><code>messageId, text, html?, editedAt</code></td>
					</tr>
					<tr><td><code>message.deleted</code></td><td><code>messageId</code></td></tr>
					<tr><td><code>direct.created</code></td><td>Encrypted direct message packet</td></tr>
					<tr>
						<td><code>direct.poked</code></td>
						<td><code>id, senderId, senderName, recipientId, message?</code></td>
					</tr>
					<tr>
						<td><code>media.producerAvailable</code></td>
						<td><code>channelId, producerId, connectionId</code></td>
					</tr>
					<tr>
						<td><code>media.producerClosed</code></td>
						<td><code>channelId, producerId</code></td>
					</tr>
					<tr>
						<td><code>media.producerState</code></td>
						<td><code>producerId, paused</code></td>
					</tr>
					<tr>
						<td><code>media.screenAvailable</code></td>
						<td><code>channelId, producerId, connectionId, audioProducerId?</code></td>
					</tr>
					<tr>
						<td><code>media.screenClosed</code></td>
						<td><code>channelId, producerId</code></td>
					</tr>
					<tr>
						<td><code>media.screenTransportFailed</code></td>
						<td><code>channelId, transportId, reason</code></td>
					</tr>
					<tr>
						<td><code>media.cameraAvailable</code></td>
						<td><code>channelId, producerId, connectionId</code></td>
					</tr>
					<tr>
						<td><code>media.cameraClosed</code></td>
						<td><code>channelId, producerId</code></td>
					</tr>
					<tr>
						<td><code>media.cameraTransportFailed</code></td>
						<td><code>channelId, transportId, reason</code></td>
					</tr>
					<tr>
						<td><code>media.consumerClosed</code></td>
						<td><code>consumerId, producerId</code></td>
					</tr>
					<tr>
						<td><code>media.speaking</code></td>
						<td><code>producerId, speaking</code></td>
					</tr>
					<tr>
						<td><code>media.transportState</code></td>
						<td><code>transportId, state</code></td>
					</tr>
					<tr>
						<td><code>media.transportFailed</code></td>
						<td><code>transportId, reason</code></td>
					</tr>
					<tr>
						<td><code>media.reset</code></td>
						<td><code>channelId, reason</code></td>
					</tr>
				</tbody>
			</table>
		</div>
		<p>
			Events can arrive before the response to the operation that triggered them. Speaking is
			sampled from SFU audio-level observations, so it may not represent every transition or
			identify silent clients.
		</p>

		<h2 id="errors"><a href="#errors" class="heading-link">Error codes</a></h2>
		<div class="table-wrap">
			<table class="error-table">
				<thead>
					<tr><th>Code</th><th>HTTP status</th><th>Meaning</th></tr>
				</thead>
				<tbody>
					<tr>
						<td><code>INVALID_REQUEST</code></td>
						<td>400</td>
						<td>Invalid envelope, fields or operation input</td>
					</tr>
					<tr>
						<td><code>VERSION_UNSUPPORTED</code></td>
						<td>400</td>
						<td>Server and client could not agree on a version</td>
					</tr>
					<tr>
						<td><code>AUTH_FAILED</code></td>
						<td>401</td>
						<td>Missing, invalid, expired or revoked credentials</td>
					</tr>
					<tr>
						<td><code>FORBIDDEN</code></td>
						<td>403</td>
						<td>Authorization or origin check failed</td>
					</tr>
					<tr>
						<td><code>NOT_FOUND</code></td>
						<td>404</td>
						<td>Resource unavailable in the caller's scope</td>
					</tr>
					<tr>
						<td><code>CONFLICT</code></td>
						<td>409</td>
						<td>Request conflicts with current state</td>
					</tr>
					<tr>
						<td><code>REFRESH_RETRY</code></td>
						<td>409</td>
						<td>A newer refresh generation already exists</td>
					</tr>
					<tr>
						<td><code>LIMIT</code></td>
						<td>429</td>
						<td>Resource limit</td>
					</tr>
					<tr>
						<td><code>RATE_LIMITED</code></td>
						<td>429</td>
						<td>Request rate exceeded</td>
					</tr>
					<tr>
						<td><code>UNAVAILABLE</code></td>
						<td>503</td>
						<td>Media worker or service unavailable</td>
					</tr>
					<tr>
						<td><code>INTERNAL</code></td>
						<td>500</td>
						<td>Unexpected server failure</td>
					</tr>
				</tbody>
			</table>
		</div>

		<div class="doc-footer">
			<p>Protocol v1, from the Kōrero source documentation.</p>
			<div class="doc-footer-links">
				<a href="{repo}/protocol.md" target="_blank" rel="noopener noreferrer">Edit this page</a>
				<a href="/host">Deploy a server <ArrowRight size={15} /></a>
			</div>
		</div>
	</main>
</div>

<SiteFooter />

<style>
	.protocol-hero {
		background: var(--muted);
	}
	.flow {
		display: grid;
		gap: 0.75rem;
		margin: 1.25rem 0 0;
		padding: 0;
		list-style: none;
		counter-reset: flow;
	}
	@media (min-width: 768px) {
		.flow {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
	}
	.flow li {
		position: relative;
		counter-increment: flow;
	}
	.flow-step {
		display: flex;
		flex-direction: column;
		height: 100%;
		border: 1px solid var(--border);
		border-radius: 12px;
		background: var(--background);
		padding: 1.1rem 1.15rem 1rem;
		transition: border-color 0.15s ease;
	}
	.flow-step:hover {
		border-color: var(--input);
	}
	.flow-icon {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		margin-bottom: 0.75rem;
		color: var(--primary);
	}
	.flow-icon::before {
		content: counter(flow);
		color: var(--muted-foreground);
		font-size: 0.875rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.flow-tech {
		display: block;
		margin-top: auto;
		border-top: 1px solid var(--border);
		padding-top: 0.6rem;
		color: var(--primary);
		font-size: 0.8125rem;
	}
	@media (min-width: 768px) {
		.flow li:not(:last-child)::after {
			content: '';
			position: absolute;
			top: 1.75rem;
			right: -0.75rem;
			width: 0.75rem;
			height: 1px;
			background: var(--input);
		}
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

	.toc-card {
		min-width: 0;
		border: 1px solid var(--border);
		border-radius: 14px;
		background: color-mix(in srgb, var(--card) 45%, transparent);
		padding: 1rem;
	}
	.toc-heading {
		margin: 0 0 0.5rem;
		padding: 0 0.6rem;
		color: var(--muted-foreground);
		font-size: 0.8125rem;
		font-weight: 600;
	}
	.toc-list {
		min-width: 0;
		display: grid;
		gap: 0.15rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.toc-list li {
		margin: 0;
		padding: 0;
	}
	.toc-link {
		display: block;
		border: 1px solid transparent;
		border-radius: 8px;
		padding: 0.5rem 0.6rem;
		color: var(--muted-foreground);
		transition:
			background 0.15s ease,
			border-color 0.15s ease,
			color 0.15s ease;
	}
	.toc-link:hover {
		background: color-mix(in srgb, var(--card) 70%, transparent);
		color: var(--foreground);
	}
	.toc-link.active {
		border-color: color-mix(in srgb, var(--primary) 32%, transparent);
		background: color-mix(in srgb, var(--primary) 9%, transparent);
		color: var(--foreground);
	}
	.toc-label {
		font-size: 0.9rem;
		font-weight: 500;
	}
	.toc-kicker {
		display: block;
		color: var(--muted-foreground);
		font-size: 0.7rem;
		line-height: 1.35;
	}
	.toc-source {
		display: flex;
		gap: 0.4rem;
		align-items: center;
		margin-top: 0.75rem;
		border-top: 1px solid var(--border);
		padding-top: 0.75rem;
		color: var(--muted-foreground);
		font-size: 0.8rem;
	}
	.toc-source:hover {
		color: var(--primary);
	}

	.protocol-docs > p {
		max-width: 50rem;
		margin-top: 1rem;
		padding-left: 0;
	}
	.protocol-docs h3 {
		margin-top: 2.5rem;
		font-size: 1.125rem;
	}
	.protocol-docs :global(.heading-link) {
		color: inherit;
	}
	.protocol-docs :global(.heading-link:hover) {
		text-decoration: none;
	}
	.protocol-docs :global(.heading-link)::after {
		content: '#';
		margin-left: 0.5rem;
		opacity: 0;
		color: var(--input);
		font-weight: 400;
		transition: opacity 0.15s ease;
	}
	.protocol-docs :global(.heading-link:hover)::after,
	.protocol-docs :global(.heading-link:focus-visible)::after {
		opacity: 1;
	}

	.conventions {
		border: 1px solid var(--border);
		border-radius: 12px;
		background: color-mix(in srgb, var(--card) 45%, transparent);
		padding: 1.1rem 1.25rem;
	}
	.protocol-docs .conventions-title {
		margin: 0;
		border: 0;
		padding: 0;
		font-size: 1rem;
	}
	.conventions dl {
		display: grid;
		gap: 0.6rem;
		margin: 0.85rem 0 0;
		font-size: 0.9375rem;
	}
	.conventions dl > div {
		display: grid;
		gap: 0.1rem 1.25rem;
	}
	@media (min-width: 640px) {
		.conventions dl > div {
			grid-template-columns: 9rem minmax(0, 1fr);
		}
	}
	.conventions dt {
		font-weight: 600;
	}
	.conventions dd {
		margin: 0;
		color: var(--muted-foreground);
	}

	.table-wrap {
		margin-top: 1.25rem;
		overflow-x: auto;
		border: 1px solid var(--border);
		border-radius: 12px;
		background: color-mix(in srgb, var(--card) 55%, transparent);
		scrollbar-color: var(--input) transparent;
		scrollbar-width: thin;
	}
	.table-wrap table {
		width: 100%;
		border-collapse: collapse;
		table-layout: fixed;
		padding-left: 0;
		font-size: 0.875rem;
	}
	.table-wrap thead th {
		border-bottom: 1px solid var(--border);
		background: color-mix(in srgb, var(--muted) 88%, var(--background));
		color: var(--muted-foreground);
		font-size: 0.8125rem;
		font-weight: 600;
		white-space: nowrap;
	}
	.table-wrap th,
	.table-wrap td {
		border-bottom: 1px solid color-mix(in srgb, var(--border) 65%, transparent);
		padding: 0.7rem 0.85rem;
		overflow-wrap: anywhere;
		vertical-align: top;
	}
	.table-wrap tbody tr {
		transition: background 0.12s ease;
	}
	.table-wrap tbody tr:hover {
		background: color-mix(in srgb, var(--primary) 5%, transparent);
	}
	.table-wrap tbody tr:last-child td {
		border-bottom: 0;
	}
	.table-wrap td code {
		border: 0;
		background: none;
		padding: 0;
		color: color-mix(in srgb, var(--foreground) 88%, var(--muted-foreground));
		overflow-wrap: anywhere;
	}
	.table-wrap td.method code {
		color: var(--foreground);
		font-size: 0.8rem;
		font-weight: 500;
		overflow-wrap: normal;
		vertical-align: middle;
	}
	.verb {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 3.1rem;
		border: 1px solid;
		border-radius: 5px;
		padding: 0.1rem 0.4rem;
		font-family: ui-monospace, 'SFMono-Regular', Menlo, monospace;
		font-size: 0.67rem;
		font-weight: 600;
		letter-spacing: 0.05em;
		line-height: 1.7;
		margin-right: 0.35rem;
		vertical-align: top;
	}
	.verb.GET {
		border-color: color-mix(in srgb, var(--success) 35%, transparent);
		background: color-mix(in srgb, var(--success) 12%, transparent);
		color: var(--success);
	}
	.verb.POST {
		border-color: color-mix(in srgb, var(--info) 35%, transparent);
		background: color-mix(in srgb, var(--info) 12%, transparent);
		color: var(--info);
	}
	.verb.PATCH {
		border-color: color-mix(in srgb, #ffd166 35%, transparent);
		background: color-mix(in srgb, #ffd166 12%, transparent);
		color: #ffd166;
	}
	.verb.DELETE {
		border-color: color-mix(in srgb, #ff9b9b 35%, transparent);
		background: color-mix(in srgb, #ff9b9b 12%, transparent);
		color: #ff9b9b;
	}
	.request-table td:first-child code,
	.media-table td:first-child code,
	.event-table td:first-child code {
		color: var(--primary);
	}
	.error-table td:first-child code {
		color: var(--accent);
	}
	.error-table td:nth-child(2) {
		color: var(--info);
		font-variant-numeric: tabular-nums;
		font-weight: 600;
	}
	.http-table {
		min-width: 44rem;
	}
	.request-table {
		min-width: 38rem;
	}
	.media-table {
		min-width: 42rem;
	}
	.event-table {
		min-width: 32rem;
	}
	.error-table {
		min-width: 28rem;
	}
	.close-table {
		min-width: 32rem;
	}
	.close-table td:first-child code {
		color: var(--accent);
	}
	.close-table th:nth-child(1) {
		width: 16%;
	}
	.close-table th:nth-child(2) {
		width: 38%;
	}
	.close-table th:nth-child(3) {
		width: 46%;
	}
	.http-table th:nth-child(1) {
		width: 28%;
	}
	.http-table th:nth-child(2) {
		width: 23%;
	}
	.http-table th:nth-child(3) {
		width: 21%;
	}
	.http-table th:nth-child(4) {
		width: 28%;
	}
	.request-table th:nth-child(1) {
		width: 26%;
	}
	.request-table th:nth-child(2) {
		width: 36%;
	}
	.request-table th:nth-child(3) {
		width: 38%;
	}
	.media-table th:nth-child(1) {
		width: 26%;
	}
	.media-table th:nth-child(2) {
		width: 42%;
	}
	.media-table th:nth-child(3) {
		width: 32%;
	}
	.event-table th:nth-child(1) {
		width: 36%;
	}
	.event-table th:nth-child(2) {
		width: 64%;
	}
	.error-table th:nth-child(1) {
		width: 28%;
	}
	.error-table th:nth-child(2) {
		width: 14%;
	}
	.error-table th:nth-child(3) {
		width: 58%;
	}

	.steps {
		counter-reset: step;
		display: grid;
		gap: 0.7rem;
		margin-top: 1.25rem;
		padding-left: 0;
		list-style: none;
	}
	.steps li {
		position: relative;
		counter-increment: step;
		margin: 0;
		border: 1px solid var(--border);
		border-radius: 12px;
		background: color-mix(in srgb, var(--card) 55%, transparent);
		padding: 1rem 1.1rem 1rem 3.4rem;
	}
	.steps li::before {
		content: counter(step);
		position: absolute;
		top: 1rem;
		left: 1rem;
		display: grid;
		place-items: center;
		width: 1.75rem;
		height: 1.75rem;
		border: 1px solid color-mix(in srgb, var(--primary) 45%, transparent);
		border-radius: 999px;
		background: color-mix(in srgb, var(--primary) 10%, transparent);
		color: var(--primary);
		font-size: 0.65rem;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
	}

	.doc-footer {
		display: flex;
		flex-wrap: wrap;
		gap: 1rem;
		align-items: center;
		justify-content: space-between;
		margin-top: 4rem;
		border-top: 1px solid var(--border);
		padding-top: 1.5rem;
	}
	.doc-footer p {
		margin: 0;
		padding-left: 0;
		color: var(--muted-foreground);
		font-size: 0.85rem;
	}
	.doc-footer-links {
		display: flex;
		flex-wrap: wrap;
		gap: 1rem;
		font-size: 0.875rem;
	}
	.doc-footer-links a {
		display: inline-flex;
		gap: 0.35rem;
		align-items: center;
	}

	@media (max-width: 1023px) {
		.toc-card {
			padding: 0.75rem;
		}
		.toc-list {
			display: flex;
			gap: 0.25rem;
			min-width: 0;
			overflow-x: auto;
			padding-bottom: 0.25rem;
		}
		.toc-list li {
			flex: 0 0 auto;
		}
		.toc-link {
			border-color: var(--border);
			padding: 0.4rem 0.7rem;
			white-space: nowrap;
		}
		.toc-kicker,
		.toc-source {
			display: none;
		}
	}

	@media (max-width: 767px) {
		.table-wrap {
			overflow: visible;
			border: 0;
			background: none;
			box-shadow: none;
		}
		.table-wrap table {
			display: block;
			min-width: 0;
			table-layout: auto;
			font-size: 0.875rem;
		}
		.table-wrap thead {
			position: absolute;
			width: 1px;
			height: 1px;
			margin: -1px;
			overflow: hidden;
			clip-path: inset(50%);
			white-space: nowrap;
		}
		.table-wrap tbody {
			display: grid;
			gap: 0.75rem;
		}
		.table-wrap tr {
			display: block;
			overflow: hidden;
			border: 1px solid var(--border);
			border-radius: 12px;
			background: color-mix(in srgb, var(--card) 55%, transparent);
		}
		.table-wrap td {
			display: block;
			border-bottom: 1px solid color-mix(in srgb, var(--border) 65%, transparent);
			padding: 0.55rem 0.8rem;
		}
		.table-wrap td:last-child {
			border-bottom: 0;
		}
		.table-wrap td::before {
			display: block;
			margin-bottom: 0.15rem;
			color: var(--muted-foreground);
			font-size: 0.75rem;
			font-weight: 600;
		}
		.http-table td:nth-child(1)::before {
			content: 'Endpoint';
		}
		.http-table td:nth-child(2)::before {
			content: 'Auth';
		}
		.http-table td:nth-child(3)::before {
			content: 'Input';
		}
		.http-table td:nth-child(4)::before {
			content: 'Successful result';
		}
		.request-table td:nth-child(1)::before,
		.media-table td:nth-child(1)::before {
			content: 'Type';
		}
		.request-table td:nth-child(2)::before,
		.media-table td:nth-child(2)::before {
			content: 'Payload fields';
		}
		.request-table td:nth-child(3)::before,
		.media-table td:nth-child(3)::before {
			content: 'Success payload';
		}
		.event-table td:nth-child(1)::before {
			content: 'Event';
		}
		.event-table td:nth-child(2)::before {
			content: 'Payload';
		}
		.error-table td:nth-child(1)::before {
			content: 'Code';
		}
		.error-table td:nth-child(2)::before {
			content: 'HTTP status';
		}
		.error-table td:nth-child(3)::before,
		.close-table td:nth-child(2)::before {
			content: 'Meaning';
		}
		.close-table td:nth-child(1)::before {
			content: 'Close code';
		}
		.close-table td:nth-child(3)::before {
			content: 'What to do';
		}
	}
</style>
