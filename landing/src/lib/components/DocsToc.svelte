<script lang="ts">
	import { onMount } from 'svelte';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';

	type Item = { id: string; label: string; kicker?: string };
	let { items, source }: { items: Item[]; source?: { href: string; label: string } } = $props();

	let active = $state('');

	onMount(() => {
		active = items[0]?.id ?? '';
		const sections = items
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

<nav aria-label="On this page" class="min-w-0 lg:sticky lg:top-20 lg:self-start">
	<div class="toc-card">
		<p class="toc-heading">On this page</p>
		<ol class="toc-list">
			{#each items as t (t.id)}
				<li>
					<a
						href="#{t.id}"
						class="toc-link"
						class:active={active === t.id}
						aria-current={active === t.id ? 'location' : undefined}
					>
						<span class="toc-label">{t.label}</span>
						{#if t.kicker}<span class="toc-kicker">{t.kicker}</span>{/if}
					</a>
				</li>
			{/each}
		</ol>
		{#if source}
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external link -->
			<a href={source.href} target="_blank" rel="noopener noreferrer" class="toc-source">
				{source.label}
				<ArrowRight size={14} />
			</a>
		{/if}
	</div>
</nav>

<style>
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
		display: grid;
		gap: 0.15rem;
		margin: 0;
		padding: 0;
		list-style: none;
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
</style>
