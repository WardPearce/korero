<script lang="ts">
  let { live = false }: { live?: boolean } = $props();
  const bars = [10, 16, 11, 24, 16, 32, 46, 27, 18, 38, 60, 42, 24, 49, 74, 54, 28, 50, 63, 36, 22, 41, 27, 16, 24, 13, 9];
</script>

<div class="signal-art" data-live={live} aria-hidden="true">
  <div class="signal-grid"></div>
  <div class="signal-orbit orbit-outer"></div>
  <div class="signal-orbit orbit-middle"></div>
  <div class="signal-orbit orbit-inner"></div>
  <div class="signal-beam"></div>
  <div class="signal-wave">
    {#each bars as height, index (index)}
      <i style:--height={`${height}%`} style:--delay={`${index * -43}ms`}></i>
    {/each}
  </div>
  <i class="signal-satellite satellite-one"></i>
  <i class="signal-satellite satellite-two"></i>
</div>
