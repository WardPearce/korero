<script lang="ts">
  import jsQR from "jsqr";

  let { onscan, onerror }: { onscan: (payload: string) => void; onerror: (message: string) => void } = $props();
  // Analyse a downscaled frame; full camera resolution is slow to decode on phones.
  const maxFrameWidth = 640;

  function camera(video: HTMLVideoElement) {
    let stopped = false;
    let frame = 0;
    let stream: MediaStream | undefined;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });

    function stopCamera() {
      stream?.getTracks().forEach((track) => track.stop());
      video.srcObject = null;
    }

    function scan() {
      if (stopped || !context) return;
      if (video.readyState >= video.HAVE_ENOUGH_DATA && video.videoWidth > 0) {
        const scale = Math.min(1, maxFrameWidth / video.videoWidth);
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const image = context.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(image.data, image.width, image.height, { inversionAttempts: "attemptBoth" });
        if (code?.data) {
          stopped = true;
          stopCamera();
          onscan(code.data);
          return;
        }
      }
      frame = requestAnimationFrame(scan);
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      onerror("This device cannot open a camera here. Use a phone or a browser with camera access.");
      return;
    }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false })
      .then(async (media) => {
        stream = media;
        if (stopped) return stopCamera();
        video.srcObject = media;
        await video.play();
        frame = requestAnimationFrame(scan);
      })
      .catch(() => {
        if (!stopped) onerror("Allow camera access to scan a device link.");
      });

    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      stopCamera();
    };
  }
</script>

<div class="scanner">
  <video {@attach camera} class="scanner-video" playsinline muted aria-label="Camera preview for scanning the device link"></video>
  <p class="field-hint">Point the camera at the QR code on the other device.</p>
</div>

<style>
  .scanner {
    display: grid;
    gap: 0.5rem;
  }

  .scanner-video {
    width: 100%;
    aspect-ratio: 1;
    object-fit: cover;
    border-radius: 0.5rem;
    background: var(--muted);
  }
</style>
