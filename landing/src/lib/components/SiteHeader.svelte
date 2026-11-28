<script lang="ts">
	import { resolve } from '$app/paths';
	import { openDownloadDialog } from '#lib/download-dialog.js';
</script>

<a
	href="#main"
	class="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground"
>
	Skip to content
</a>

<header
	class="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur-md supports-[not(backdrop-filter:blur(0))]:bg-background"
>
	<div class="mx-auto flex max-w-6xl items-center justify-between gap-6 px-6 py-3.5">
		<a href={resolve('/')} aria-label="Kōrero home">
			<img src="/korero-logo.svg" alt="Kōrero." class="h-6" />
		</a>
		<nav
			aria-label="Primary"
			class="flex items-center gap-4 text-sm text-muted-foreground sm:gap-6"
		>
			<a href={resolve('/#features')} class="hover:text-foreground max-sm:hidden">Features</a>
			<a href={resolve('/host')} class="hover:text-foreground max-sm:hidden">Host a server</a>
			<a href={resolve('/protocol')} class="hover:text-foreground max-sm:hidden">Protocol</a>
			<a href={resolve('/sdk')} class="hover:text-foreground">SDK</a>
			<a
				href="https://github.com/WardPearce/korero"
				target="_blank"
				rel="noopener noreferrer"
				aria-label="Kōrero on GitHub (opens in a new tab)"
				title="Kōrero on GitHub"
				class="hover:text-foreground"
			>
				<svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor" class="size-5">
					<path
						d="M12 .5C5.73.5.5 5.73.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2.17c-3.2.7-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a10.9 10.9 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5Z"
					/>
				</svg>
			</a>
			<a
				href={resolve('/#get')}
				class="rounded-lg bg-primary px-3.5 py-1.5 font-medium text-primary-foreground hover:brightness-110"
				onclick={(event) => {
					event.preventDefault();
					openDownloadDialog();
				}}
			>
				Get Kōrero
			</a>
		</nav>
	</div>
</header>
