import { resolve } from "node:path";
import { _electron as electron, chromium } from "playwright";
import { fingerprint } from "../../src/security/tls";
import { fixture, until, type Snapshot } from "../server";
import type { harness } from "./browser";

declare global {
  interface Window {
    harness: typeof harness;
    koreroDesktop: { invoke<T>(command: string, args: Record<string, unknown>): Promise<T> };
    voiceConnections: RTCPeerConnection[];
    playbackLevels: Map<string, () => number>;
  }
}

const frontend = resolve(import.meta.dir, "../../../frontend");
const server = await fixture();
try {
  const owner = await server.ws(await server.owner());
  const { channelId: whisperRoom } = await owner.rpc<{ channelId: string }>("channel.create", { name: "Whisper destination" });
  const { payload: { serverId } } = await server.call<{ serverId: string }>("/api/v1/server/info");
  const bundle = await Bun.build({ entrypoints: [import.meta.dir + "/browser.ts"], target: "browser", format: "iife" });
  if (!bundle.success) throw new Error("Could not build the browser peer");
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH,
    args: ["--autoplay-policy=no-user-gesture-required", "--ignore-certificate-errors-spki-list=" + fingerprint(server.ca).slice("sha256/".length)] });
  try {
    const peer = await browser.newPage();
    await peer.goto(server.origin + "/api/v1/server/info");
    await peer.addScriptTag({ content: await bundle.outputs[0]!.text() });
    await peer.evaluate(() => window.harness.initialize("Chromium voice peer"));
    const app = await electron.launch({
      executablePath: require(resolve(frontend, "node_modules/electron")),
      args: [frontend, "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
        "--user-data-dir=" + resolve(server.directory, "electron")],
    });
    try {
      const page = await app.firstWindow();
      page.on("pageerror", (error) => console.error(error.message));
      await page.addInitScript(() => {
        const connections: RTCPeerConnection[] = [];
        window.voiceConnections = connections;
        window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {
          construct(target, args, newTarget) {
            const connection = Reflect.construct(target, args, newTarget) as RTCPeerConnection;
            connections.push(connection);
            return connection;
          },
        });
        // Packets arriving is not enough: Chromium can leave a remote track silent in Web Audio.
        const levels = new Map<string, () => number>();
        window.playbackLevels = levels;
        const createSource = AudioContext.prototype.createMediaStreamSource;
        AudioContext.prototype.createMediaStreamSource = function (stream) {
          const source = createSource.call(this, stream);
          const analyser = this.createAnalyser();
          const samples = new Float32Array(analyser.fftSize);
          source.connect(analyser);
          const track = stream.getAudioTracks()[0];
          if (track) levels.set(track.id, () => {
            analyser.getFloatTimeDomainData(samples);
            return Math.max(...samples.map(Math.abs));
          });
          return source;
        };
      });
      await page.waitForFunction(async () => (await indexedDB.databases()).some(({ name }) => name === "korero-device"));
      await page.evaluate(async ({ origin, serverId }) => {
        const { invoke } = window.koreroDesktop;
        const { fingerprint } = await invoke<{ fingerprint: string }>("inspect_server", { address: origin });
        const rejected = await invoke("prepare_server", { origin, fingerprint: "" }).then(() => false, () => true);
        if (!rejected) throw new Error("Electron accepted an unapproved certificate");
        await invoke("inspect_server", { address: origin });
        await invoke("prepare_server", { origin, fingerprint });
        const badgeDenied = await invoke("api_fetch", { origin, method: "PATCH", path: "/api/v1/admin/badges" })
          .then(() => false, (error: Error) => error.message.includes("You are not signed in"));
        if (!badgeDenied) throw new Error("The badge relay did not require an authenticated session");
        const identity = await invoke<{ publicKey: string; privateKey: string }>("generate_identity", {});
        const { privateKey } = identity;
        await new Promise<void>((resolve, reject) => {
          const request = indexedDB.open("korero-device");
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const database = request.result;
            const transaction = database.transaction(["identities", "local"], "readwrite");
            transaction.onerror = () => reject(transaction.error);
            transaction.oncomplete = () => { database.close(); resolve(); };
            transaction.objectStore("identities").put({ id: "default", ...identity });
            const local = transaction.objectStore("local");
            local.put({ key: "username", value: "Electron voice peer" });
            local.put({ key: "audio", value: {
              transmitMode: "pushToTalk", talkShortcut: { code: "F8", alt: false, ctrl: false, shift: false, meta: false },
            } });
          };
        });
        localStorage.setItem("korero:identity-mode", "local");
        const { status, body } = await invoke<{ status: number; body: unknown }>("authenticate_identity", {
          origin, serverId, privateKey, deviceName: "Electron", action: { operation: "register", displayName: "Electron voice peer" },
        });
        if (status !== 201) throw new Error("Electron sign-in failed");
        if (!body || typeof body !== "object" || Object.keys(body).some((key) => key !== "account")) {
          throw new Error("The desktop sign-in exposed session credentials to the renderer");
        }
        await invoke("start_session", { origin });
      }, { origin: server.origin, serverId });
      const state = await until(() => page.evaluate(async () => {
        const [state] = await window.koreroDesktop.invoke<{ snapshot: (Snapshot & { targetAudioBitrate: number }) | null }[]>("voice_state", {});
        return state?.snapshot;
      }), Boolean);
      if (!state) throw new Error("Electron session did not connect");
      const { connectionId, targetAudioBitrate } = state;
      const channelId = state.channels.find(({ name }) => name === "Lobby")!.id;

      // The renderer restores the signed-in session and handles subsequent channel changes.
      await page.reload();
      const command = (kind: string, payload: Record<string, unknown> = {}) => page.evaluate(
        ({ kind, args }) => window.koreroDesktop.invoke(kind, args), { kind, args: { origin: server.origin, ...payload } });
      const producers = () => peer.evaluate(() => window.harness.rpc<{ connectionId: string; producerId: string }[]>("media.producers"));
      await command("join_channel", { channelId });
      const producer = await until(async () => (await producers()).find((entry) => entry.connectionId === connectionId), Boolean);
      if (!producer) throw new Error("Electron did not publish a producer");
      const microphoneEnabled = (enabled: boolean) => page.waitForFunction((expected) => window.voiceConnections.some(
        (connection) => connection.getSenders().some(({ track }) => track?.readyState === "live" && track.enabled === expected)),
      enabled, { timeout: 8000 });
      await microphoneEnabled(false);
      await page.keyboard.down("F8");
      await microphoneEnabled(true);
      const decoded = await peer.evaluate((id) => window.harness.consume(id, false), producer.producerId);
      if (decoded.codec.toLowerCase() !== "audio/opus" || decoded.packets <= 0) throw new Error("Chromium did not decode Electron audio");
      await page.keyboard.up("F8");
      await microphoneEnabled(false);
      await peer.evaluate(() => window.harness.publish(false));
      await page.waitForFunction(async () => {
        for (const connection of window.voiceConnections) {
          for (const row of (await connection.getStats()).values()) {
            if (row.type === "inbound-rtp" && row.kind === "audio" && row.totalAudioEnergy > 0) return true;
          }
        }
        return false;
      }, undefined, { timeout: 8000 });
      await page.waitForFunction(() => window.voiceConnections.some((connection) => connection.getReceivers()
        .some(({ track }) => track.kind === "audio" && (window.playbackLevels.get(track.id)?.() ?? 0) > 0.01)),
      undefined, { timeout: 8000 }).catch(() => {
        throw new Error("Electron received remote audio but Web Audio rendered silence");
      });

      for (const audioBitrate of [32000, 128000, null]) {
        await owner.rpc("channel.edit", { channelId, audioBitrate });
        await page.waitForFunction((bitrate) => window.voiceConnections.some((connection) => connection.getSenders().some(
          (sender) => sender.track?.readyState === "live" && sender.getParameters().encodings[0]?.maxBitrate === bitrate)),
        audioBitrate ?? targetAudioBitrate, { timeout: 8000 });
        if (!(await producers()).some(({ producerId }) => producerId === producer.producerId)) {
          throw new Error("Changing the bitrate replaced the voice producer");
        }
      }

      await command("set_presence", { muted: true });
      await until(async () => !(await producers()).some(({ connectionId: id }) => id === connectionId), Boolean);
      await command("set_presence", { muted: false });
      await until(async () => (await producers()).some(({ connectionId: id }) => id === connectionId), Boolean);
      await owner.rpc("channel.join", { channelId });
      await peer.evaluate((id) => window.harness.join(id), whisperRoom);
      await page.getByRole("button", { name: "Whisper to another channel" }).click();
      // Narrow windows mount a second voice toolbar in the mobile dock, so its closed dialog's fields also exist.
      const whisperDialog = page.getByRole("dialog", { name: "Channel whisper" });
      await whisperDialog.getByLabel("Target channel").click();
      await page.getByRole("option", { name: "Whisper destination", exact: true }).click();
      await whisperDialog.getByLabel("Activation").click();
      await page.getByRole("option", { name: "Toggle-to-talk", exact: true }).click();
      await whisperDialog.getByRole("button", { name: "Start whisper" }).click();
      const whisper = await until(async () => (await producers()).find((entry) => entry.connectionId === connectionId), Boolean);
      if (!whisper) throw new Error("Electron did not publish a whisper");
      await peer.evaluate((id) => window.harness.consume(id, false), whisper.producerId);
      const publicProducers = await owner.rpc<{ connectionId: string }[]>("media.producers");
      if (publicProducers.some((entry) => entry.connectionId === connectionId)) throw new Error("Public audio remained active during the whisper");
      await whisperDialog.getByRole("button", { name: "Stop whisper" }).click();
      await until(async () => !(await producers()).some(({ connectionId: id }) => id === connectionId), Boolean);
      await until(async () => (await owner.rpc<{ connectionId: string }[]>("media.producers"))
        .some((entry) => entry.connectionId === connectionId), Boolean);
      await microphoneEnabled(false);

      await command("leave_channel");
      await until(async () => !(await owner.rpc<{ connectionId: string }[]>("media.producers"))
        .some((entry) => entry.connectionId === connectionId), Boolean);
      console.log("Electron and Chromium decoded Opus in both directions. Push-to-talk, bitrate changes, mute, whisper and leave passed.");
    } finally { await app.close(); }
  } finally { await browser.close(); owner.close(); }
} finally { await server.cleanup(); }
