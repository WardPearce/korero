<script lang="ts">
	import { resolve } from '$app/paths';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import CodeBlock from '#lib/components/CodeBlock.svelte';
	import DocsToc from '#lib/components/DocsToc.svelte';
	import SiteFooter from '#lib/components/SiteFooter.svelte';
	import SiteHeader from '#lib/components/SiteHeader.svelte';

	const source = 'https://github.com/WardPearce/korero/tree/main/sdk';
	const toc = [
		{ id: 'install', label: 'Install' },
		{ id: 'bot', label: 'Build a ping bot' },
		{ id: 'channels', label: 'Channel and message actions' },
		{ id: 'events', label: 'Listen for events' },
		{ id: 'clients', label: 'Build your own client' }
	];

	const install = 'npm install korero-chat';

	const createIdentity = `(
  umask 077
  set -C
  bun -e 'import { generateIdentity } from "korero-chat";
    console.log((await generateIdentity()).privateKey);' > .korero-key
)`;

	const bot = `import { Channel, KoreroClient, identityFromPrivateKey } from "korero-chat";

const {
  KORERO_SERVER, KORERO_CHANNEL_ID, KORERO_PRIVATE_KEY,
  KORERO_REGISTER, KORERO_INVITATION, KORERO_SERVER_PASSWORD
} = process.env;

if (!KORERO_SERVER || !KORERO_PRIVATE_KEY) {
  throw new Error("Set KORERO_SERVER and KORERO_PRIVATE_KEY.");
}

const client = new KoreroClient(KORERO_SERVER);
const channel = KORERO_CHANNEL_ID ? new Channel(KORERO_CHANNEL_ID, client) : undefined;

client.on("messageCreate", (message) => {
  if (message.channel.id !== channel?.id) return;
  if (message.senderId === client.state.snapshot?.account.id) return;
  if (message.text === "!ping") {
    void message.channel.send("Pong!").catch(console.error);
  }
});

const { channels } = await client.connect({
  identity: identityFromPrivateKey(KORERO_PRIVATE_KEY),
  deviceName: "Ping bot",
  action: KORERO_REGISTER === "1"
    ? { operation: "register", displayName: "Ping bot",
        invitation: KORERO_INVITATION, password: KORERO_SERVER_PASSWORD }
    : { operation: "login", password: KORERO_SERVER_PASSWORD }
});

if (channel) {
  await channel.follow();
} else {
  console.table(channels.map(({ id, name }) => ({ id, name })));
  await client.disconnect();
}`;

	const register = `export KORERO_SERVER=https://chat.example.org:8443
export KORERO_PRIVATE_KEY="$(cat .korero-key)"
KORERO_REGISTER=1 bun run bot.ts`;

	const run = `export KORERO_CHANNEL_ID=your-channel-id
bun run bot.ts`;

	const channelExample = `const channel = client.channel(channelId);
await channel.follow();
await channel.send("Hello from Kōrero");

const messages = await channel.history();
for (const message of messages) {
  console.log(message.senderId, message.text);
}`;

	const events = [
		['ready', 'The initial server snapshot, including the account and visible channels.'],
		['state', 'The latest connection status, server snapshot and recent messages.'],
		['messageCreate', 'A live ChannelMessage with its channel and methods to edit or delete it.'],
		['messageUpdate', 'The message ID, updated content and edit timestamp.'],
		['messageDelete', 'The deleted message ID.'],
		['directMessage', 'An encrypted direct-message packet, including queued offline messages.'],
		['directMessageChange', 'An encrypted direct-message edit or a deletion reference.'],
		['poke', 'An incoming poke.'],
		['raw', 'The original live signaling event with its protocol type and payload.']
	];
</script>

<svelte:head>
	<title>Kōrero TypeScript SDK</title>
	<meta
		name="description"
		content="Install the Kōrero TypeScript SDK, build a bot, and use channel actions and typed events in your own client."
	/>
</svelte:head>

<SiteHeader />

<section class="border-b border-border bg-muted">
	<div class="mx-auto max-w-7xl px-6 py-16 lg:py-20">
		<h1 class="text-4xl leading-[1.05] font-semibold sm:text-5xl">Kōrero TypeScript SDK</h1>
		<p class="mt-5 max-w-2xl text-lg text-muted-foreground">
			Build a bot or your own Kōrero client. Sign in with an identity, send messages through channel
			objects, and listen for typed events.
		</p>
		<div class="mt-8 flex flex-wrap gap-3">
			<a
				href="#install"
				class="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 font-medium text-primary-foreground hover:brightness-110"
			>
				Install the SDK <ArrowRight size={16} aria-hidden="true" />
			</a>
			<a
				href={resolve('/protocol')}
				class="inline-flex items-center rounded-lg border border-border bg-card px-4 py-2 font-medium hover:border-input"
			>
				Protocol reference
			</a>
		</div>
	</div>
</section>

<div class="mx-auto grid max-w-7xl gap-12 px-6 py-16 lg:grid-cols-[15rem_minmax(0,1fr)]">
	<DocsToc items={toc} source={{ href: source, label: 'Browse SDK source' }} />

	<main id="main" class="docs max-w-[48rem] min-w-0">
		<h2 id="install">Install</h2>
		<p>
			The SDK runs on Bun, Node.js 22 or newer, and modern browsers with Web Crypto. Install the
			<a href="https://www.npmjs.com/package/korero-chat">korero-chat package</a> from your project directory.
		</p>
		<CodeBlock lang="bash" code={install} />

		<h2 id="bot">Build a ping bot</h2>
		<h3>Create an identity</h3>
		<p>
			Generate a key once and keep using it on later runs. Keep <code>.korero-key</code> private and
			out of source control. If you already have an encrypted Kōrero identity backup, load it with
			<code>importIdentity(backup, passphrase)</code>.
		</p>
		<CodeBlock lang="bash" code={createIdentity} />

		<h3>Register and start the bot</h3>
		<p>
			Save this example as <code>bot.ts</code>. The handler listens for <code>!ping</code> in the
			configured channel and replies through <code>message.channel</code>.
		</p>
		<CodeBlock lang="typescript" label="bot.ts" code={bot} />
		<p>
			Set your server's HTTPS origin. If registration requires an invitation, set
			<code>KORERO_INVITATION</code> to the invitation token. If the server requires a password, set
			<code>KORERO_SERVER_PASSWORD</code>.
		</p>
		<CodeBlock lang="bash" code={register} />
		<p>
			The first run registers the identity and prints visible channel IDs. Set
			<code>KORERO_CHANNEL_ID</code> to one of those IDs for later runs. Use a channel where the bot's
			account has permission to read and send messages.
		</p>
		<CodeBlock lang="bash" code={run} />

		<h2 id="channels">Channel and message actions</h2>
		<p>
			<code>client.channel(id)</code> is shorthand for <code>new Channel(id, client)</code>.
			<code>channel.follow()</code> subscribes to live chat. A connection can follow one channel in addition
			to the channel it has joined.
		</p>
		<CodeBlock lang="typescript" code={channelExample} />
		<p>
			Use <code>channel.join(password?)</code> for membership and <code>client.leaveChannel()</code>
			to leave. With the appropriate permissions, use <code>client.createChannel(options)</code>,
			<code>channel.edit(changes)</code> and <code>channel.delete()</code>. Messages from events and
			history expose <code>message.edit(content)</code> and <code>message.delete()</code>.
		</p>

		<h2 id="events">Listen for events</h2>
		<p>
			Register handlers with <code>client.on(event, handler)</code> or
			<code>client.once(event, handler)</code>. Use <code>client.off(event, handler)</code> to
			remove a handler registered with <code>on</code>. Register direct-message handlers before
			connecting to receive queued messages.
		</p>
		<div class="mt-4 overflow-hidden rounded-lg border border-border">
			<table class="[&_tbody_tr:last-child_td]:border-b-0 [&_td:first-child]:w-[40%]">
				<thead>
					<tr><th scope="col">Event</th><th scope="col">Payload</th></tr>
				</thead>
				<tbody>
					{#each events as [name, description] (name)}
						<tr><td><code>{name}</code></td><td>{description}</td></tr>
					{/each}
				</tbody>
			</table>
		</div>

		<h2 id="clients">Build your own client</h2>
		<p>
			Each <code>KoreroClient</code> connects to one server. Read <code>client.state</code> for the
			current snapshot and subscribe to <code>state</code> for updates. Use <code>client.api</code>
			for typed HTTP endpoints such as server information, account settings and administration.
			<code>client.disconnect()</code> closes signaling and revokes the device session. Create a new client
			to connect again after disconnecting.
		</p>
		<p>
			For encrypted direct messages, look up the peer with <code>client.directPeer()</code>, create
			a conversation with <code>directConversation()</code>, and send the encrypted packet with
			<code>client.sendDirect()</code>. Confirm that <code>ownPublicKey</code> matches your enrolled
			key and verify the safety code with the recipient before sending or decrypting.
			<a href={resolve('/protocol#direct')}>Direct-message protocol</a>
		</p>
		<p>
			The default transport uses the runtime's HTTPS trust store and WebSocket implementation. A
			browser's origin must be allowed by the Kōrero server. Pass a <code>Transport</code> to the
			client constructor for custom certificate trust, or a <code>SessionMediaAdapter</code> to integrate
			voice.
		</p>
	</main>
</div>

<SiteFooter />

<style>
	.docs h2:first-child {
		margin-top: 0;
		padding-top: 0;
		border: 0;
	}

	.docs p {
		margin-top: 0.75rem;
		padding-left: 0;
		color: var(--muted-foreground);
	}
</style>
