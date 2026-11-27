<script lang="ts">
	import './layout.css';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();
</script>

<svelte:head>
	<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
	<title>Kōrero: self-hosted voice and chat</title>
	<meta
		name="description"
		content="Kōrero is a self-hosted voice server with encrypted direct messages, screenshare and an open protocol. Run it on your own machine."
	/>
	<meta name="theme-color" content="#0c1218" />
</svelte:head>

{@render children()}
