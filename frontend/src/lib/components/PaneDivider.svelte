<script lang="ts">
  let { label, value, min, max, controls, resize }: {
    label: string; value: number; min: number; max: number;
    controls: string; resize: (value: number, commit: boolean) => void;
  } = $props();

  let drag: { id: number; x: number; width: number } | undefined;

  function update(width: number, commit: boolean) {
    resize(Math.round(Math.max(min, Math.min(max, width))), commit);
  }

  function start(event: PointerEvent) {
    if (event.button !== 0 || drag) return;
    drag = { id: event.pointerId, x: event.clientX, width: value };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function move(event: PointerEvent) {
    if (drag?.id === event.pointerId) update(drag.width + event.clientX - drag.x, false);
  }

  function finish(event: PointerEvent) {
    if (drag?.id !== event.pointerId) return;
    drag = undefined;
    update(value, true);
  }

  function key(event: KeyboardEvent) {
    const step = event.shiftKey ? 32 : 8;
    const widths = { ArrowLeft: value - step, ArrowRight: value + step, Home: min, End: max };
    if (!Object.hasOwn(widths, event.key)) return;
    event.preventDefault();
    update(widths[event.key as keyof typeof widths], true);
  }
</script>

<div class="pane-divider" role="separator" tabindex="0" aria-label={label} aria-controls={controls}
  aria-orientation="vertical" aria-valuenow={value} aria-valuemin={min} aria-valuemax={max}
  onkeydown={key} onpointerdown={start} onpointermove={move} onlostpointercapture={finish}></div>
