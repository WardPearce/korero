<script lang="ts">
	import SiteHeader from '#lib/components/SiteHeader.svelte';
	import SiteFooter from '#lib/components/SiteFooter.svelte';
	import CodeBlock from '#lib/components/CodeBlock.svelte';
	import Bold from '@lucide/svelte/icons/bold';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Code from '@lucide/svelte/icons/code';
	import Headphones from '@lucide/svelte/icons/headphones';
	import Italic from '@lucide/svelte/icons/italic';
	import List from '@lucide/svelte/icons/list';
	import Mail from '@lucide/svelte/icons/mail';
	import MessageCircle from '@lucide/svelte/icons/message-circle';
	import Mic from '@lucide/svelte/icons/mic';
	import PhoneOff from '@lucide/svelte/icons/phone-off';
	import AudioLines from '@lucide/svelte/icons/audio-lines';
	import ListTree from '@lucide/svelte/icons/list-tree';
	import Server from '@lucide/svelte/icons/server';
	import Settings2 from '@lucide/svelte/icons/settings-2';
	import Plus from '@lucide/svelte/icons/plus';
	import Quote from '@lucide/svelte/icons/quote';
	import Radio from '@lucide/svelte/icons/radio';
	import Search from '@lucide/svelte/icons/search';
	import Send from '@lucide/svelte/icons/send';
	import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
	import Smile from '@lucide/svelte/icons/smile';
	import Strikethrough from '@lucide/svelte/icons/strikethrough';
	import Underline from '@lucide/svelte/icons/underline';
	import X from '@lucide/svelte/icons/x';
	import MicOff from '@lucide/svelte/icons/mic-off';
	import Monitor from '@lucide/svelte/icons/monitor';

	const features = [
		{
			title: 'Voice that stays on your server',
			body: 'A WebRTC SFU carries Opus audio through your own machine. Set a bitrate per channel, and use push-to-talk or toggle-to-talk, even system-wide on supported desktops.'
		},
		{
			title: 'Screenshare and camera together',
			body: 'Share a window, tab or whole display at up to 1080p with source audio. Preview locally, then go live when you are ready.'
		},
		{
			title: 'Direct messages with safety codes',
			body: 'Compare codes with your contact before a conversation opens. If they are offline, the server holds the encrypted message and delivers it when they connect.'
		},
		{
			title: 'No account required',
			body: 'Your identity is an Ed25519 key pair created on your device, so there is no sign-up and no password. A hosted account is optional: use it to restore your identity and servers on any device, or skip it and link a phone by scanning a QR code.'
		},
		{
			title: 'Channels, roles and an audit log',
			body: 'Nest channels, password-protect them, and assign Guest, Member and Moderator roles. The audit log records joins, moderation and server changes.'
		},
		{
			title: 'Rich messages and files',
			body: 'Format text, pick emoji and attach files up to 32 MiB. Attachments follow your message retention settings.'
		}
	];

	const mockServers = [
		{ name: 'Whānau Hangout', active: true, online: true },
		{ name: 'Friday Night Games', active: false, online: true },
		{ name: 'Studio Crew', active: false, online: false }
	];

	const mockChannels = [
		{
			name: 'Chat',
			active: true,
			unread: 0,
			users: [
				{
					n: 'wardybara',
					c: 'bg-secondary',
					role: 'Owner',
					speaking: true,
					sharing: true,
					muted: false
				},
				{
					n: 'cocomilk',
					c: 'bg-primary',
					role: 'Moderator',
					speaking: false,
					sharing: false,
					muted: false
				},
				{ n: 'ensyy', c: 'bg-accent', role: '', speaking: false, sharing: false, muted: true }
			]
		},
		{ name: 'Lobby', active: false, unread: 0, users: [] },
		{ name: 'clips', active: false, unread: 3, users: [] },
		{ name: 'music', active: false, unread: 0, users: [] }
	];

	const mockMessages = [
		{
			n: 'cocomilk',
			c: 'bg-primary',
			t: '19:42',
			body: 'Server is back up, that restart took about four seconds.'
		},
		{ n: 'car3well', c: 'bg-info', t: '19:43', body: 'Nice. Voice sounds clean on my end too.' },
		{ n: 'FamiliarRuin', c: 'bg-success', t: '19:43', body: 'Who is up for a round of something?' },
		{
			n: 'wardybara',
			c: 'bg-secondary',
			t: '19:44',
			body: 'Sharing my screen in Game night now, jump in whenever.'
		},
		{ n: 'ensyy', c: 'bg-accent', t: '19:44', body: 'Joining. Can everyone see the 1080p stream?' }
	];

	const platforms = ['Linux desktop', 'Android', 'iOS', 'Web browser'];
</script>

<SiteHeader />

<main id="main">
	<!-- Hero -->
	<section class="mx-auto grid max-w-6xl items-center gap-12 px-6 py-20 lg:py-24">
		<div>
			<h1 class="text-4xl leading-[1.08] font-semibold sm:text-6xl">Talk on a server you own.</h1>
			<p class="mt-6 max-w-[34rem] text-lg text-muted-foreground">
				Kōrero is a voice and chat server you run yourself. Your friends, community or team join
				with a key, speak in channels, share screens and message each other privately. Nothing
				passes through anyone else's cloud.
			</p>
			<div class="mt-9 flex flex-wrap gap-3">
				<a
					href="#get"
					class="rounded-lg bg-primary px-5 py-2.5 font-medium text-primary-foreground hover:brightness-110"
				>
					Download the app
				</a>
				<a
					href="/host"
					class="rounded-lg border border-border bg-card px-5 py-2.5 font-medium hover:border-input"
				>
					Run your own server
				</a>
			</div>
			<p class="mt-5 text-sm text-muted-foreground">
				{platforms.join(', ')}.
			</p>
		</div>

		<!-- App mock: mirrors the real client layout -->
		<div
			class="overflow-hidden rounded-xl border border-border bg-background text-[0.9375rem] shadow-[0_30px_60px_rgb(0_0_0/45%)] lg:col-span-2"
			role="img"
			aria-label="Kōrero app showing the Whānau Hangout server with a Lobby channel"
		>
			<div
				class="grid h-[34rem] grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)_auto_auto] md:grid-cols-[13rem_1px_14rem_1px_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)] lg:grid-cols-[14.5rem_1px_24.5rem_1px_minmax(0,1fr)]"
				aria-hidden="true"
			>
				<!-- Server rail -->
				<div class="flex min-w-0 flex-col bg-muted max-md:hidden">
					<div class="flex-1 p-3">
						<img src="/korero-logo.svg" alt="" class="mb-5 h-7 w-28" />
						<div
							class="flex h-9 items-center gap-2 rounded-lg border border-border bg-background px-2 text-sm"
						>
							<Plus size={16} /> Connect to server
						</div>
						<p class="mt-5 mb-2 text-xs font-bold tracking-wider text-muted-foreground">SERVERS</p>
						<div class="flex flex-col gap-2">
							{#each mockServers as srv (srv.name)}
								<div
									class="flex h-11 items-stretch overflow-hidden rounded-lg border bg-background text-sm {srv.active
										? 'border-foreground'
										: 'border-border text-muted-foreground'}"
								>
									<span
										class="flex min-w-0 flex-1 items-center gap-2 px-2 {srv.active
											? 'font-semibold'
											: ''}"
									>
										<span class="truncate">{srv.name}</span>
										<span
											class="ml-auto size-1.5 shrink-0 rounded-full {srv.online
												? 'bg-success'
												: 'bg-border'}"
										></span>
									</span>
									{#if srv.active}
										<span class="grid w-9 place-items-center border-l border-border">
											<X size={14} />
										</span>
									{/if}
								</div>
							{/each}
						</div>
					</div>
					<div class="flex items-center gap-2 border-t border-border p-2">
						<span
							class="grid size-8 shrink-0 place-items-center rounded-full bg-secondary text-sm text-black"
						>
							W
						</span>
						<span class="min-w-0 text-sm leading-tight">
							<b class="block truncate">wardybara</b>
							<span class="text-xs text-muted-foreground">
								<span class="mr-1 inline-block size-1.5 rounded-full bg-success"></span>Connected
							</span>
						</span>
						<span
							class="ml-auto grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-background max-md:hidden"
						>
							<SlidersHorizontal size={16} />
						</span>
					</div>
				</div>
				<div class="bg-border max-md:hidden"></div>

				<!-- Channel pane -->
				<div class="flex min-w-0 flex-col bg-muted max-md:hidden">
					<div class="border-b border-border px-4 py-4 text-xl">Whānau Hangout</div>
					<div class="border-b border-border px-4 py-2 text-sm text-muted-foreground">
						7 total <span class="ml-2 inline-block size-1.5 rounded-full bg-success"></span> 4 online
					</div>
					<div class="flex gap-2 overflow-hidden border-b border-border p-2.5 max-lg:hidden">
						<span class="flex h-9 overflow-hidden rounded-lg border border-border">
							<span class="grid w-9 place-items-center text-muted-foreground">
								<Mic size={16} />
							</span>
							<span class="grid w-8 place-items-center border-l border-input">
								<ChevronDown size={16} />
							</span>
						</span>
						<span class="flex h-9 overflow-hidden rounded-lg border border-border">
							<span class="grid w-9 place-items-center text-muted-foreground">
								<Headphones size={16} />
							</span>
							<span class="grid w-8 place-items-center border-l border-input">
								<ChevronDown size={16} />
							</span>
						</span>
						<span
							class="flex h-9 items-center gap-1 rounded-lg border border-border px-3 text-sm text-muted-foreground"
						>
							AFK <ChevronDown size={14} />
						</span>
						<span
							class="grid h-9 w-9 place-items-center rounded-lg border border-border text-muted-foreground"
						>
							<Radio size={16} />
						</span>
						<span class="mx-0.5 w-px bg-border"></span>
						<span
							class="grid h-9 w-9 place-items-center rounded-lg border border-border text-muted-foreground"
						>
							<PhoneOff size={16} />
						</span>
						<span
							class="grid h-9 w-9 place-items-center rounded-lg border border-border text-muted-foreground"
						>
							<SlidersHorizontal size={16} />
						</span>
					</div>
					<div class="border-b border-border p-2.5">
						<div
							class="flex h-9 items-center gap-2 rounded-lg bg-secondary px-3 text-sm font-semibold text-black"
						>
							<Mail size={16} /> Direct messages
							<span
								class="ml-auto rounded-full bg-black/80 px-1.5 text-xs font-semibold text-white"
							>
								1
							</span>
						</div>
					</div>
					<div class="min-h-0 flex-1 overflow-hidden p-2.5">
						<div
							class="flex h-9 items-center gap-2 rounded-lg border border-input bg-background px-3 text-sm font-semibold"
						>
							<Search size={14} /> Search channels
						</div>
						<div class="mt-3 flex flex-col gap-2">
							{#each mockChannels as ch (ch.name)}
								<div
									class="flex h-10 items-center gap-2 rounded-lg border px-3 text-sm {ch.active
										? 'border-primary bg-primary/10 font-bold'
										: 'border-border bg-background'}"
								>
									{#if ch.active}<ChevronDown size={14} />{/if}
									{ch.name}
									{#if ch.unread}
										<span
											class="ml-auto rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-foreground"
										>
											{ch.unread}
										</span>
									{:else if ch.active}
										<span class="ml-auto size-1.5 rounded-full bg-success"></span>
									{/if}
								</div>
								{#each ch.users as u (u.n)}
									<div class="flex items-center gap-2 py-0.5 pr-2 pl-4 text-sm">
										<span
											class="grid size-6 shrink-0 place-items-center rounded-full text-xs text-black {u.c} {u.speaking
												? 'ring-2 ring-success'
												: ''}"
										>
											{u.n[0].toUpperCase()}
										</span>
										<span class="truncate">{u.n}</span>
										{#if u.role}
											<span class="rounded border border-primary px-1.5 text-xs text-foreground">
												{u.role}
											</span>
										{/if}
										<span class="ml-auto flex gap-1 text-muted-foreground">
											{#if u.sharing}<Monitor size={13} class="text-info" />{/if}
											{#if u.muted}<MicOff size={13} />{/if}
										</span>
									</div>
								{/each}
							{/each}
						</div>
					</div>
					<div class="mt-auto border-t border-border p-2.5">
						<span
							class="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-background px-3 text-sm text-muted-foreground"
						>
							<Plus size={14} /> Channel
						</span>
					</div>
				</div>
				<div class="bg-border max-md:hidden"></div>

				<!-- Room pane -->
				<div class="flex min-w-0 flex-col">
					<div class="flex items-center gap-3 border-b border-border px-4 py-3">
						<span class="grid size-9 place-items-center rounded-lg border border-border bg-muted">
							<MessageCircle size={18} />
						</span>
						<span class="leading-tight">
							<span class="block text-xs text-muted-foreground">Channel chat</span>
							<span class="text-lg font-medium">Lobby</span>
						</span>
						<span
							class="ml-auto flex h-9 items-center gap-2 rounded-lg border border-input bg-background px-3 text-sm font-medium"
						>
							<Headphones size={14} /> Join voice
						</span>
					</div>
					<div class="flex min-h-0 flex-1 flex-col justify-end gap-4 overflow-hidden px-4 py-4">
						{#each mockMessages as m (m.t + m.body)}
							<div class="flex gap-3">
								<span
									class="grid size-9 shrink-0 place-items-center rounded-full text-sm text-black {m.c}"
								>
									{m.n[0].toUpperCase()}
								</span>
								<div class="min-w-0 leading-snug">
									<p>
										<b class="text-sm">{m.n}</b>
										<span class="ml-1 text-xs text-muted-foreground">{m.t}</span>
									</p>
									<p class="text-sm text-muted-foreground">{m.body}</p>
								</div>
							</div>
						{/each}
					</div>
					<div class="border-t border-border bg-muted p-3">
						<div class="rounded-lg border border-input bg-background">
							<p class="px-3 py-3 text-muted-foreground">Message #Lobby</p>
							<div
								class="flex items-center gap-4 border-t border-border px-3 py-2 text-muted-foreground"
							>
								<Bold size={16} /><Italic size={16} /><Underline size={16} /><Strikethrough
									size={16}
								/><Code size={16} /><Quote size={16} class="max-sm:hidden" /><List
									size={16}
									class="max-sm:hidden"
								/>
								<span class="ml-auto flex gap-2">
									<span class="grid size-9 place-items-center rounded-lg border border-border">
										<Smile size={16} />
									</span>
									<span
										class="grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground"
									>
										<Send size={16} />
									</span>
								</span>
							</div>
						</div>
					</div>
				</div>

				<!-- Mobile: voice toolbar + bottom nav -->
				<div class="flex gap-2 border-t border-border bg-muted p-2 md:hidden">
					<span
						class="grid h-9 w-9 place-items-center rounded-lg border border-border text-muted-foreground"
					>
						<Mic size={16} />
					</span>
					<span
						class="grid h-9 w-9 place-items-center rounded-lg border border-border text-muted-foreground"
					>
						<Headphones size={16} />
					</span>
					<span
						class="flex h-9 items-center gap-1 rounded-lg border border-border px-3 text-sm text-muted-foreground"
					>
						AFK <ChevronDown size={14} />
					</span>
					<span
						class="ml-auto grid h-9 w-9 place-items-center rounded-lg border border-border text-muted-foreground"
					>
						<PhoneOff size={16} />
					</span>
				</div>
				<div
					class="grid grid-cols-4 gap-1 border-t border-border bg-muted px-1 pt-1 pb-1.5 text-xs md:hidden"
				>
					<span class="flex flex-col items-center gap-0.5 rounded-lg p-1 text-muted-foreground">
						<Server size={18} /> Servers
					</span>
					<span class="flex flex-col items-center gap-0.5 rounded-lg p-1 text-muted-foreground">
						<ListTree size={18} /> Channels
					</span>
					<span
						class="flex flex-col items-center gap-0.5 rounded-lg bg-primary/10 p-1 font-semibold"
					>
						<AudioLines size={18} /> Chat
					</span>
					<span class="flex flex-col items-center gap-0.5 rounded-lg p-1 text-muted-foreground">
						<Settings2 size={18} /> Settings
					</span>
				</div>
			</div>
		</div>
	</section>

	<!-- Name -->
	<section class="border-y border-border bg-muted">
		<div class="mx-auto max-w-6xl px-6 py-14">
			<p class="max-w-[40rem] text-xl leading-relaxed">
				<span class="font-semibold">Kōrero</span> is the Māori word for conversation. That is the whole
				idea: a place to talk, with the people you choose, on hardware you control.
			</p>
		</div>
	</section>

	<!-- Features -->
	<section id="features" class="mx-auto max-w-6xl scroll-mt-4 px-6 py-24">
		<h2 class="max-w-xl text-3xl sm:text-4xl">Everything a community needs to talk</h2>
		<div class="mt-12 grid gap-x-12 gap-y-10 md:grid-cols-2 lg:grid-cols-3">
			{#each features as f (f.title)}
				<div class="border-t border-border pt-5">
					<h3 class="text-lg">{f.title}</h3>
					<p class="mt-2 text-muted-foreground">{f.body}</p>
				</div>
			{/each}
		</div>
	</section>

	<!-- Host -->
	<section id="host" class="scroll-mt-4 border-y border-border bg-muted">
		<div class="mx-auto grid max-w-6xl items-center gap-12 px-6 py-24 lg:grid-cols-2">
			<div>
				<h2 class="text-3xl sm:text-4xl">One process. One data directory.</h2>
				<p class="mt-5 max-w-[34rem] text-muted-foreground">
					The server is a single Bun process with a small pool of media workers and a SQLite
					database. The first owner claims it with a setup token, and a TLS identity is generated
					for you. Choose how long messages are kept, or keep none.
				</p>
				<p class="mt-4 max-w-[34rem] text-muted-foreground">
					Connect over direct-IP HTTPS and WebSocket. There is no account on our side and no relay
					in the middle.
				</p>
			</div>
			<div>
				<CodeBlock
					lang="bash"
					label="Deploy with Docker"
					code={`docker run -d --name korero --restart unless-stopped \\
  -p 8443:8443 -p 8444:8444/udp -p 8444:8444/tcp \\
  -v korero-data:/data -e VOICE_DATA_DIR=/data \\
  wardpearce/korero-server:latest
docker logs korero`}
				/>
				<CodeBlock
					lang="bash"
					label="Or run the standalone binary"
					code={`chmod +x voice-server-linux-amd64
./voice-server-linux-amd64 --data-dir ./data`}
				/>
				<p class="mt-5 text-sm text-muted-foreground">
					Read the setup token from the log and paste it into the app to claim the server.
					<a href="/host" class="text-foreground underline underline-offset-4 hover:text-primary">
						Read the hosting docs
					</a>
				</p>
			</div>
		</div>
	</section>

	<!-- Protocol -->
	<section id="protocol" class="mx-auto max-w-6xl scroll-mt-4 px-6 py-24">
		<div class="grid gap-12 lg:grid-cols-[1fr_1fr]">
			<h2 class="max-w-md text-3xl sm:text-4xl">Open to any client</h2>
			<div class="text-muted-foreground">
				<p class="max-w-[34rem]">
					The v1 protocol is documented with a JSON schema, so anyone can write a client or bot. The
					official app is built with SvelteKit and runs on Electron, Capacitor and in the browser.
				</p>
				<p class="mt-4 max-w-[34rem]">
					Servers recognise your Ed25519 identity and apply their own registration policies, so one
					key works across every server you join.
				</p>
			</div>
		</div>
	</section>

	<!-- Get -->
	<section id="get" class="scroll-mt-4 border-t border-border bg-muted">
		<div class="mx-auto max-w-6xl px-6 py-24">
			<h2 class="max-w-xl text-3xl sm:text-4xl">Pick up the conversation</h2>
			<p class="mt-4 max-w-[34rem] text-muted-foreground">
				Create an optional hosted account to restore your identity and saved servers on any device,
				or continue with a local identity.
			</p>
			<ul class="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
				{#each platforms as p (p)}
					<li>
						<a
							href="https://github.com/WardPearce/korero"
							class="block rounded-xl border border-border bg-card px-5 py-4 font-medium hover:border-input"
						>
							{p}
						</a>
					</li>
				{/each}
			</ul>
		</div>
	</section>
</main>

<SiteFooter />
