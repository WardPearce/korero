<script lang="ts">
	import { Slider as SliderPrimitive } from "bits-ui";
	import { cn, type WithoutChildrenOrChild } from "#lib/utils.js";

	let {
		ref = $bindable(null),
		value = $bindable(),
		orientation = "horizontal",
		thumbLabelledBy,
		variant = "default",
		level,
		class: className,
		...restProps
	}: WithoutChildrenOrChild<SliderPrimitive.RootProps> & {
		thumbLabelledBy?: string;
		variant?: "default" | "threshold";
		/** A live 0-100 indicator drawn over the track, as on the threshold variant. */
		level?: number;
	} = $props();

	let clampedLevel = $derived(level === undefined ? undefined : Math.min(100, Math.max(0, level)));
</script>

<!--
Discriminated Unions + Destructing (required for bindable) do not
get along, so we shut typescript up by casting `value` to `never`.
-->
<SliderPrimitive.Root
	bind:ref
	bind:value={value as never}
	data-slot="slider"
	{orientation}
	class={cn(
		"data-[orientation=vertical]:min-h-40 relative flex w-full touch-none items-center select-none data-disabled:opacity-50 data-[orientation=vertical]:h-full data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col",
		className
	)}
	{...restProps}
>
	{#snippet children({ thumbItems })}
		<span
			data-slot="slider-track"
			data-orientation={orientation}
			class={cn(
				"relative grow overflow-hidden",
				variant === "threshold"
					? "bg-success data-[orientation=horizontal]:h-2 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-2 rounded-full"
					: "bg-border rounded-sm data-[orientation=horizontal]:h-1 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1"
			)}
		>
			<SliderPrimitive.Range
				data-slot="slider-range"
				class={cn(
					"absolute select-none data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full",
					variant === "threshold" ? "bg-warning" : "bg-primary"
				)}
			/>
			{#if variant === "threshold" && orientation === "horizontal" && clampedLevel}
				<span
					data-slot="slider-level"
					class="pointer-events-none absolute inset-y-0 start-0 bg-foreground/30 transition-[width] duration-75 ease-linear"
					style:width={`${clampedLevel}%`}
				>
					<span class="absolute inset-y-0 end-0 w-[2px] bg-foreground"></span>
				</span>
			{/if}
		</span>
		{#each thumbItems as thumb (thumb.index)}
			<SliderPrimitive.Thumb
				data-slot="slider-thumb"
				index={thumb.index}
				aria-labelledby={thumbLabelledBy}
				class={variant === "threshold"
					? "relative block size-4 shrink-0 rounded-full border-2 border-background bg-foreground shadow-md ring-ring/50 transition-[color,box-shadow] after:absolute after:-inset-2.5 select-none hover:ring-4 focus-visible:ring-4 focus-visible:outline-hidden active:ring-4 disabled:pointer-events-none disabled:opacity-50"
					: "border-ring ring-ring/50 relative size-3 rounded-sm border bg-primary transition-[color,box-shadow] after:absolute after:-inset-2 hover:ring-3 focus-visible:ring-3 focus-visible:outline-hidden active:ring-3 block shrink-0 select-none disabled:pointer-events-none disabled:opacity-50"}
			/>
		{/each}
	{/snippet}
</SliderPrimitive.Root>
