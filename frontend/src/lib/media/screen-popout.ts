export interface ScreenPlayback {
  muted: boolean;
  volume: number;
}

export function openScreenPopout(
  stream: MediaStream,
  title: string,
  playback: ScreenPlayback,
  onClose: () => void,
  onStop?: () => void,
) {
  const popup = window.open("about:blank", `korero-screen-share-${crypto.randomUUID()}`, "popup,width=960,height=600");
  if (!popup || popup.closed) return;

  try {
    const doc = popup.document;
    doc.title = title;
    doc.documentElement.lang = "en";
    const appRoot = document.documentElement;
    const syncTheme = () => {
      const appStyle = getComputedStyle(appRoot);
      for (const property of ["color-scheme", "--background", "--foreground", "--card", "--input",
        "--control-hover", "--control-height", "--radius", "--type-small", "--font-sans", "--focus-ring"]) {
        doc.documentElement.style.setProperty(property, appStyle.getPropertyValue(property));
      }
    };
    syncTheme();

    const style = doc.createElement("style");
    style.textContent = `
      html { font: var(--type-small)/1.5 var(--font-sans); background: var(--background); color: var(--foreground); }
      body { margin: 0; height: 100dvh; display: grid; grid-template-rows: auto minmax(0, 1fr); }
      header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 12px; background: var(--card); }
      .actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
      video { width: 100%; height: 100%; background: #000; object-fit: contain; }
      button {
        min-height: var(--control-height);
        padding: 0 10px;
        border: 1px solid var(--input);
        border-radius: var(--radius);
        background: var(--background);
        color: inherit;
        cursor: pointer;
        font: inherit;
      }
      button:hover { background: var(--control-hover); }
      button:focus-visible { outline: var(--focus-ring); outline-offset: 2px; }
    `;
    doc.head.append(style);

    const header = doc.createElement("header");
    const heading = doc.createElement("strong");
    heading.textContent = title;
    const actions = doc.createElement("div");
    actions.className = "actions";
    const dock = doc.createElement("button");
    dock.type = "button";
    dock.textContent = "Return to app";
    actions.append(dock);
    header.append(heading, actions);

    const video = doc.createElement("video");
    video.setAttribute("aria-label", title);
    video.autoplay = true;
    video.playsInline = true;
    video.defaultMuted = playback.muted;
    video.muted = playback.muted;
    video.volume = playback.volume;
    video.srcObject = stream;
    doc.body.replaceChildren(header, video);
    if (!playback.muted) {
      void video.play().catch(() => {
        // Browsers can block audible autoplay; fall back to silent playback of the share.
        video.muted = true;
        void video.play().catch(() => {});
      });
    }

    const themeObserver = new MutationObserver(syncTheme);
    themeObserver.observe(appRoot, { attributeFilter: ["style"] });
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      themeObserver.disconnect();
      window.clearInterval(checkClosed);
      window.removeEventListener("pagehide", close);
      popup.removeEventListener("pagehide", finish);
      video.srcObject = null;
      onClose();
    };
    const close = () => {
      finish();
      popup.close();
    };
    const checkClosed = window.setInterval(() => { if (popup.closed) finish(); }, 500);
    window.addEventListener("pagehide", close);
    popup.addEventListener("pagehide", finish);
    dock.onclick = close;
    if (onStop) {
      const stop = doc.createElement("button");
      stop.type = "button";
      stop.textContent = "Stop watching";
      stop.onclick = () => {
        close();
        onStop();
      };
      actions.append(stop);
    }
    return {
      close,
      focus: () => popup.focus(),
      setPlayback: (next: ScreenPlayback) => {
        if (finished || popup.closed) return;
        video.muted = next.muted;
        video.volume = next.volume;
      },
    };
  } catch {
    popup.close();
  }
}
