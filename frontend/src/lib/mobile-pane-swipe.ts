import type { Attachment } from "svelte/attachments";
import { on } from "svelte/events";
import type { MobilePane } from "./workspace";

// Settings is a separate route, but on mobile it sits after the chat room in the swipe order.
export type SwipePane = MobilePane | "settings";

const panes: readonly SwipePane[] = ["servers", "channels", "room", "settings"];
const directionThreshold = 8;
const swipeDistance = 60;
const horizontalRatio = 1.5;

interface Gesture {
  start: Touch;
  pane: SwipePane;
  swiping: boolean;
}

function hasHorizontalScroll(target: Element, shell: HTMLElement) {
  for (let element: Element | null = target; element && element !== shell; element = element.parentElement) {
    if (element.scrollWidth > element.clientWidth && /^(auto|scroll)$/.test(getComputedStyle(element).overflowX)) return true;
  }
  return false;
}

export function mobilePaneSwipe(currentPane: () => SwipePane, navigate: (pane: SwipePane) => void): Attachment<HTMLElement> {
  return (shell) => {
    let gesture: Gesture | undefined;

    function cancel() {
      gesture = undefined;
    }

    function start(event: TouchEvent) {
      cancel();
      const target = event.target;
      if (event.touches.length !== 1 || !(target instanceof Element) || !target.closest(".server-rail, .channel-pane, .room-pane, .settings-shell")) return;
      if (target.closest("dialog, input, textarea, select, [contenteditable], [role='slider'], .composer, .voice-toolbar")) return;
      gesture = { start: event.touches[0], pane: currentPane(), swiping: false };
    }

    function move(event: TouchEvent) {
      if (!gesture) return;
      const touch = event.touches[0];
      if (event.touches.length !== 1 || touch.identifier !== gesture.start.identifier || !event.cancelable) return cancel();
      if (!gesture.swiping) {
        const x = Math.abs(touch.clientX - gesture.start.clientX);
        const y = Math.abs(touch.clientY - gesture.start.clientY);
        if (Math.max(x, y) < directionThreshold) return;
        const target = gesture.start.target;
        if (x < y * horizontalRatio || (target instanceof Element && hasHorizontalScroll(target, shell))) return cancel();
        gesture.swiping = true;
      }
      // Cancel native handling only once the direction is clear, so vertical scrolling and pinch zoom still work.
      event.preventDefault();
    }

    function end(event: TouchEvent) {
      const completed = gesture;
      cancel();
      const touch = event.changedTouches[0];
      if (!completed?.swiping || touch?.identifier !== completed.start.identifier || completed.pane !== currentPane()) return;
      const x = touch.clientX - completed.start.clientX;
      const y = touch.clientY - completed.start.clientY;
      if (Math.abs(x) < swipeDistance || Math.abs(x) < Math.abs(y) * horizontalRatio) return;
      const next = panes[panes.indexOf(completed.pane) + (x < 0 ? 1 : -1)];
      if (next) navigate(next);
    }

    const listeners = [
      on(shell, "touchstart", start, { passive: true }),
      on(shell, "touchmove", move, { passive: false }),
      on(shell, "touchend", end, { passive: true }),
      on(shell, "touchcancel", cancel, { passive: true }),
      on(shell, "contextmenu", cancel, { capture: true }),
    ];
    return () => { for (const remove of listeners) remove(); };
  };
}
