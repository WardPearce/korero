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
	import Search from '@lucide/svelte/icons/search';
	import Send from '@lucide/svelte/icons/send';
	import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
	import Smile from '@lucide/svelte/icons/smile';
	import Strikethrough from '@lucide/svelte/icons/strikethrough';
	import Underline from '@lucide/svelte/icons/underline';
	import X from '@lucide/svelte/icons/x';
	import MicOff from '@lucide/svelte/icons/mic-off';
	import Monitor from '@lucide/svelte/icons/monitor';
	import Apple from '@lucide/svelte/icons/apple';
	import Smartphone from '@lucide/svelte/icons/smartphone';
	import Terminal from '@lucide/svelte/icons/terminal';
	import { openDownloadDialog } from '#lib/download-dialog.js';

	const pillars = [
		{
			title: 'Voice that feels like the same room',
			body: 'Hop between channels and just talk. Use an open mic, push-to-talk or toggle-to-talk, with shortcuts that keep working while you are in a game. Whisper to another channel without leaving your own.',
			tech: 'Opus over a WebRTC SFU on your server, 32 to 128 kbit/s per channel.'
		},
		{
			title: 'Show your screen and your face',
			body: 'Share a window or your whole display with its sound, and turn your camera on at the same time. Check the preview first, then go live when you are ready.',
			tech: 'Screenshare up to 1440p with source audio, VP8 camera up to 6 Mbit/s.'
		},
		{
			title: 'Private messages stay private',
			body: 'Direct messages are locked on your device before they leave it. Compare a short safety code with your friend once, and you know nobody is reading along. If they are offline, the message waits for them.',
			tech: 'X25519 key agreement, AES-256-GCM and Ed25519 signatures. The server only sees ciphertext.'
		}
	];

	const extras: { title: string; body: string; tech?: string }[] = [
		{
			title: 'No sign-up, no password',
			body: 'Your identity is created on your device. Back it up with an optional account, or link your phone by scanning a QR code.',
			tech: 'An Ed25519 key pair per identity.'
		},
		{
			title: 'Channels the way you like them',
			body: 'Nest channels, lock them with a password, and drag yourself between them. Set who can do what, per role and per channel.'
		},
		{
			title: 'Moderation with a paper trail',
			body: 'Guest, Member and Moderator roles, plus your own. Mute, move, kick and ban, and see every change in the audit log.'
		},
		{
			title: 'Chat with formatting and files',
			body: 'Bold, quotes, code blocks, emoji and attachments. You decide how big files can be and how much space they take.',
			tech: 'Up to 32 MiB per file, with storage limits per server and per account.'
		},
		{
			title: 'You choose what is kept',
			body: 'Keep messages for a week, a year, or not at all. Everything lives in one folder on your machine, so backups are a copy away.'
		},
		{
			title: 'Away when you need a minute',
			body: 'Go AFK with a short note so people know when you will be back. The desktop app keeps itself up to date.'
		}
	];

	const hostSteps = [
		{
			title: 'Start the server',
			body: 'Run one Docker command or a single binary. It creates its own certificate, a Lobby channel and a setup token.'
		},
		{
			title: 'Claim it',
			body: 'Paste the setup token into the app to become the owner. Name the server and set who can join.'
		},
		{
			title: 'Invite your people',
			body: 'Share the address or an invitation. Friends connect straight to your machine, with nothing in between.'
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
		{ name: 'clips', active: false, unread: 3, users: [] }
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
		{ n: 'ensyy', c: 'bg-accent', t: '19:44', body: 'Joining. Can everyone see the 1440p stream?' }
	];

	const platforms = [
		{ name: 'Windows', detail: 'Installer or portable archive', icon: Monitor },
		{ name: 'macOS', detail: 'Disk image for Apple silicon', icon: Apple },
		{ name: 'Linux', detail: 'AppImage, .deb or .rpm', icon: Terminal },
		{ name: 'Android', detail: 'APK for phones and tablets', icon: Smartphone }
	];
</script>

<SiteHeader />

<main id="main">
	<!-- Hero -->
	<section
		class="mx-auto grid max-w-6xl items-center gap-14 px-6 py-16 sm:py-20 xl:grid-cols-[minmax(0,30rem)_minmax(0,1fr)] xl:gap-12"
	>
		<div>
			<h1 class="text-4xl leading-[1.08] font-semibold sm:text-5xl lg:text-6xl">
				Talk on a server you own.
			</h1>
			<p class="mt-6 max-w-[34rem] text-lg text-muted-foreground">
				Kōrero is an open source voice and chat server you run yourself. Your friends, community or
				team join with a key, speak in channels, share screens and message each other privately.
				Nothing passes through anyone else's cloud.
			</p>
			<div class="mt-9 flex flex-wrap gap-3">
				<a
					href="#get"
					class="rounded-lg bg-primary px-5 py-2.5 font-medium text-primary-foreground hover:brightness-110"
					onclick={(event) => {
						event.preventDefault();
						openDownloadDialog();
					}}
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
				Free and open source, for {platforms.map((p) => p.name).join(', ')}.
			</p>
		</div>

		<!-- App mock: mirrors the real client layout -->
		<div
			class="hero-mock @container/mock overflow-hidden rounded-xl border border-border bg-background text-[0.9375rem] shadow-[0_30px_60px_rgb(0_0_0/45%)] max-md:hidden"
			role="img"
			aria-label="Kōrero app showing the Whānau Hangout server with a Lobby channel"
		>
			<div
				class="grid h-[38rem] grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)_auto_auto] @lg/mock:grid-cols-[14rem_1px_minmax(0,1fr)] @lg/mock:grid-rows-[minmax(0,1fr)] @4xl/mock:grid-cols-[14rem_1px_18rem_1px_minmax(0,1fr)]"
				aria-hidden="true"
			>
				<!-- Server rail -->
				<div class="hidden min-w-0 flex-col bg-muted @4xl/mock:flex">
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
				<div class="hidden bg-border @4xl/mock:block"></div>

				<!-- Channel pane -->
				<div class="hidden min-w-0 flex-col bg-muted @lg/mock:flex">
					<div class="truncate border-b border-border px-4 py-4 text-xl">Whānau Hangout</div>
					<div class="border-b border-border px-4 py-2 text-sm text-muted-foreground">
						7 total <span class="ml-2 inline-block size-1.5 rounded-full bg-success"></span> 4 online
					</div>
					<div class="hidden items-center gap-2 border-b border-border p-2.5 @lg/mock:flex">
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
											<span
												class="hidden rounded border border-primary px-1.5 text-xs text-foreground @4xl/mock:inline"
											>
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
				<div class="hidden bg-border @lg/mock:block"></div>

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
				<div class="flex gap-2 border-t border-border bg-muted p-2 @lg/mock:hidden">
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
					class="grid grid-cols-4 gap-1 border-t border-border bg-muted px-1 pt-1 pb-1.5 text-xs @lg/mock:hidden"
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
	<section id="features" class="mx-auto max-w-6xl px-6 py-24">
		<h2 class="max-w-xl text-3xl sm:text-4xl">Everything a community needs to talk</h2>
		<p class="mt-4 max-w-[36rem] text-lg text-muted-foreground">
			Built for friend groups, gaming crews, clubs and small teams who would rather keep their
			conversations at home.
		</p>

		<div class="mt-14 grid gap-x-10 gap-y-12 lg:grid-cols-3">
			{#each pillars as f (f.title)}
				<div class="border-t-2 border-primary pt-6">
					<h3 class="text-xl sm:text-2xl">{f.title}</h3>
					<p class="mt-3 text-muted-foreground">{f.body}</p>
					<p class="tech-note mt-5">{f.tech}</p>
				</div>
			{/each}
		</div>

		<div class="mt-20 grid gap-x-10 gap-y-10 md:grid-cols-2 lg:grid-cols-3">
			{#each extras as f (f.title)}
				<div class="border-t border-border pt-5">
					<h3 class="text-lg">{f.title}</h3>
					<p class="mt-2 text-muted-foreground">{f.body}</p>
					{#if f.tech}<p class="tech-note mt-4">{f.tech}</p>{/if}
				</div>
			{/each}
		</div>
	</section>

	<!-- Host -->
	<section id="host" class="border-y border-border bg-muted">
		<div
			class="mx-auto grid max-w-6xl gap-12 px-6 py-24 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:gap-16"
		>
			<div>
				<h2 class="text-3xl sm:text-4xl">Your server, up in a minute</h2>
				<p class="mt-5 text-muted-foreground">
					If you can run a Docker container, you can host Kōrero. A home server, a small VPS or a
					spare laptop is plenty.
				</p>
				<ol class="host-steps mt-10">
					{#each hostSteps as step (step.title)}
						<li>
							<h3 class="font-semibold">{step.title}</h3>
							<p class="mt-1 text-muted-foreground">{step.body}</p>
						</li>
					{/each}
				</ol>
			</div>
			<div class="min-w-0 lg:pt-2">
				<CodeBlock
					lang="bash"
					label="Run with Docker"
					code={`docker run -d --name korero --restart unless-stopped \\
  -p 8443:8443 -p 8444:8444/udp -p 8444:8444/tcp \\
  -v korero-data:/data -e VOICE_DATA_DIR=/data \\
  wardpearce/korero-server:latest
docker logs korero`}
				/>
				<CodeBlock
					lang="bash"
					label="Or run the standalone Linux binary"
					code={`chmod +x voice-server-linux-amd64
./voice-server-linux-amd64 --data-dir ./data`}
				/>
				<p class="tech-note mt-6">
					One Bun process, a few media workers and a SQLite database, all in one data folder.
					Clients connect over HTTPS and WebSocket directly. There is no account on our side and no
					relay in the middle.
				</p>
				<a
					href="/host"
					class="mt-6 inline-flex rounded-lg border border-border bg-card px-5 py-2.5 font-medium hover:border-input"
				>
					Read the hosting guide
				</a>
			</div>
		</div>
	</section>

	<!-- Protocol -->
	<section id="protocol" class="mx-auto max-w-6xl px-6 py-24">
		<div class="grid gap-10 lg:grid-cols-2 lg:gap-16">
			<h2 class="max-w-md text-3xl sm:text-4xl">Open to any client</h2>
			<div>
				<p class="max-w-[34rem] text-muted-foreground">
					Kōrero speaks a documented, versioned protocol. Write a bot, your own client or an
					integration in any language, and it works with every Kōrero server. One identity works on
					every server you join.
				</p>
				<p class="tech-note mt-5">
					JSON over HTTPS and WebSocket, WebRTC for media, and a JSON Schema for every request.
				</p>
				<a
					href="/protocol"
					class="mt-6 inline-flex rounded-lg border border-border bg-card px-5 py-2.5 font-medium hover:border-input"
				>
					Read the protocol docs
				</a>
			</div>
		</div>
	</section>

	<!-- Get -->
	<section id="get" class="border-t border-border bg-muted">
		<div class="mx-auto max-w-6xl px-6 py-24">
			<h2 class="max-w-xl text-3xl sm:text-4xl">Pick up the conversation</h2>
			<p class="mt-4 max-w-[36rem] text-muted-foreground">
				Download the app for your device. Start with an identity that lives only on that device, or
				create an optional account to restore it anywhere.
			</p>
			<ul class="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
				{#each platforms as p (p.name)}
					<li>
						<button
							type="button"
							onclick={openDownloadDialog}
							class="flex h-full w-full items-start gap-3 rounded-xl border border-border bg-card px-5 py-4 text-left hover:border-input"
						>
							<p.icon size={20} class="mt-0.5 shrink-0 text-primary" aria-hidden="true" />
							<span>
								<span class="block font-medium">{p.name}</span>
								<span class="block text-sm text-muted-foreground">{p.detail}</span>
							</span>
						</button>
					</li>
				{/each}
			</ul>
			<p class="mt-6 text-sm text-muted-foreground">
				Looking for checksums or older versions?
				<a
					href="https://github.com/WardPearce/korero/releases"
					target="_blank"
					rel="noopener noreferrer"
					class="text-foreground underline underline-offset-4 hover:text-primary"
				>
					Browse all releases on GitHub
				</a>
			</p>
		</div>
	</section>
</main>

<SiteFooter />

<style>
	.tech-note {
		border-left: 2px solid color-mix(in srgb, var(--primary) 55%, transparent);
		padding-left: 0.75rem;
		color: color-mix(in srgb, var(--muted-foreground) 85%, var(--primary));
		font-size: 0.875rem;
		line-height: 1.5;
	}
	.host-steps {
		counter-reset: step;
		display: grid;
		gap: 1.75rem;
	}
	.host-steps li {
		position: relative;
		counter-increment: step;
		padding-left: 3rem;
	}
	.host-steps li::before {
		content: counter(step);
		position: absolute;
		top: -0.1rem;
		left: 0;
		display: grid;
		place-items: center;
		width: 2rem;
		height: 2rem;
		border: 1px solid var(--primary);
		border-radius: 999px;
		color: var(--primary);
		font-size: 0.875rem;
		font-weight: 600;
	}
	.host-steps li:not(:last-child)::after {
		content: '';
		position: absolute;
		top: 2.25rem;
		bottom: -1.5rem;
		left: calc(1rem - 0.5px);
		width: 1px;
		background: var(--border);
	}
	@media (min-width: 80rem) {
		.hero-mock {
			margin-right: max(-28rem, calc((72rem - 100vw) / 2));
		}
	}
</style>
