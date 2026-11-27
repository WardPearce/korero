<script lang="ts">
	import { tick } from 'svelte';
	import Apple from '@lucide/svelte/icons/apple';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Download from '@lucide/svelte/icons/download';
	import Monitor from '@lucide/svelte/icons/monitor';
	import Smartphone from '@lucide/svelte/icons/smartphone';
	import Terminal from '@lucide/svelte/icons/terminal';
	import X from '@lucide/svelte/icons/x';
	import { closeDownloadDialog, downloadDialogOpen } from '#lib/download-dialog.js';
	import { getLatestRelease } from '#lib/releases-client.js';
	import type { LatestRelease, PlatformId } from '#lib/releases.js';

	let release = $state<LatestRelease | null>(null);
	let releaseRequested = false;

	// Fetch the latest release in the browser the first time the dialog opens.
	$effect(() => {
		if (!$downloadDialogOpen || releaseRequested) return;

		releaseRequested = true;
		void getLatestRelease().then((latest) => {
			release = latest;
			if (!latest) releaseRequested = false;
		});
	});

	const releaseUrl = $derived(
		release?.url ?? 'https://github.com/WardPearce/korero/releases/latest'
	);

	const platformOptions: { id: PlatformId; name: string; icon: typeof Terminal }[] = [
		{ id: 'linux', name: 'Linux', icon: Terminal },
		{ id: 'windows', name: 'Windows', icon: Monitor },
		{ id: 'macos', name: 'macOS', icon: Apple },
		{ id: 'android', name: 'Android', icon: Smartphone }
	];

	const options = $derived(
		platformOptions.map((platform) => ({
			...platform,
			download: release?.platforms.find((entry) => entry.id === platform.id)
		}))
	);

	function formatSize(bytes: number) {
		if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
		return `${Math.round(bytes / (1024 * 1024))} MB`;
	}

	let panel = $state<HTMLDivElement>();
	let closeButton = $state<HTMLButtonElement>();

	$effect(() => {
		if (!$downloadDialogOpen) return;

		const trigger = document.activeElement as HTMLElement | null;
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		void tick().then(() => closeButton?.focus());

		return () => {
			document.body.style.overflow = previousOverflow;
			trigger?.focus();
		};
	});

	function handleKeydown(event: KeyboardEvent) {
		if (!$downloadDialogOpen) return;

		if (event.key === 'Escape') {
			event.preventDefault();
			closeDownloadDialog();
			return;
		}

		if (event.key !== 'Tab' || !panel) return;

		const focusable = panel.querySelectorAll<HTMLElement>('a[href], button:not([disabled])');
		if (focusable.length === 0) return;

		const first = focusable[0];
		const last = focusable[focusable.length - 1];

		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	}

	function handleBackdropClick(event: MouseEvent) {
		if (event.target === event.currentTarget) closeDownloadDialog();
	}
</script>

<svelte:window onkeydown={handleKeydown} />

{#if $downloadDialogOpen}
	<div
		class="backdrop fixed inset-0 z-50 flex items-end justify-center bg-background/80 p-4 backdrop-blur-sm sm:items-center"
		role="presentation"
		onclick={handleBackdropClick}
	>
		<div
			bind:this={panel}
			role="dialog"
			aria-modal="true"
			aria-labelledby="download-title"
			aria-describedby="download-description"
			class="panel w-full max-w-2xl overflow-hidden rounded-2xl border border-border bg-card shadow-[0_30px_80px_rgb(0_0_0/60%)]"
		>
			<div class="flex items-start justify-between gap-4 border-b border-border px-7 py-6">
				<div>
					<h2 id="download-title" class="text-xl">Get Kōrero</h2>
					<p id="download-description" class="mt-1 text-sm text-muted-foreground">
						{#if release}
							Latest release {release.version}. Choose your platform for a direct download.
						{:else}
							Choose your platform. Every build is on the latest GitHub release.
						{/if}
					</p>
				</div>
				<button
					bind:this={closeButton}
					type="button"
					aria-label="Close download options"
					class="grid size-9 shrink-0 place-items-center rounded-lg border border-border text-muted-foreground hover:border-input hover:text-foreground"
					onclick={closeDownloadDialog}
				>
					<X size={18} />
				</button>
			</div>

			<ul class="grid gap-3 p-5 sm:grid-cols-2">
				{#each options as option (option.id)}
					<li
						class="flex h-full flex-col rounded-xl border border-border bg-background hover:border-input hover:bg-muted"
					>
						<a
							href={option.download?.primary.url ?? releaseUrl}
							target="_blank"
							rel="external noopener noreferrer"
							class="group flex items-center gap-4 px-5 py-5"
						>
							<span
								class="grid size-10 shrink-0 place-items-center rounded-lg border border-border text-primary"
							>
								<option.icon size={20} />
							</span>
							<span class="min-w-0">
								<span class="block font-medium">{option.name}</span>
								{#if option.download}
									<span class="block text-xs text-muted-foreground">
										{option.download.primary.label} · {formatSize(option.download.primary.size)}
									</span>
								{:else}
									<span class="block text-xs text-muted-foreground">View releases</span>
								{/if}
							</span>
							{#if option.download}
								<Download
									size={18}
									class="ml-auto shrink-0 text-muted-foreground group-hover:text-foreground"
								/>
							{:else}
								<ChevronRight
									size={18}
									class="ml-auto shrink-0 text-muted-foreground group-hover:text-foreground"
								/>
							{/if}
						</a>
						{#if option.download?.alternatives.length}
							<div
								class="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-5 py-3 text-xs text-muted-foreground"
							>
								{#each option.download.alternatives as alternative (alternative.label)}
									<a
										href={alternative.url}
										target="_blank"
										rel="external noopener noreferrer"
										class="hover:text-foreground hover:underline hover:underline-offset-4"
									>
										{alternative.label}
									</a>
								{/each}
							</div>
						{/if}
					</li>
				{/each}
			</ul>

			<div
				class="flex flex-wrap items-center justify-end gap-3 border-t border-border px-7 py-5 text-sm text-muted-foreground"
			>
				<a
					href={releaseUrl}
					target="_blank"
					rel="external noopener noreferrer"
					class="font-medium text-foreground underline underline-offset-4 hover:text-primary"
				>
					All downloads
				</a>
			</div>
		</div>
	</div>
{/if}

<style>
	.backdrop {
		animation: backdrop-in 140ms ease-out;
	}
	.panel {
		animation: panel-in 160ms ease-out;
	}
	@keyframes backdrop-in {
		from {
			opacity: 0;
		}
	}
	@keyframes panel-in {
		from {
			opacity: 0;
			transform: translateY(8px) scale(0.98);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.backdrop,
		.panel {
			animation: none;
		}
	}
</style>
