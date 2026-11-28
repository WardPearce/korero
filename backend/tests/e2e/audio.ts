import { chromium } from "playwright";
import { fixture, trusted, until } from "../server";
import { fingerprint } from "../../src/security/tls";
import type { harness } from "./browser";

declare global { interface Window { harness: typeof harness } }
type VoicePresence = { afk: boolean; afkMessage: string; muted: boolean; deafened: boolean };

const args = process.argv.slice(2);
const dockerImage = process.env.VOICE_TEST_DOCKER_IMAGE;
const binary = args.find((arg) => !arg.startsWith("--"));
const ip = args.includes("--ipv6") ? "::1" : process.env.VOICE_TEST_IP ?? "127.0.0.1";
const forceTcp = args.includes("--tcp");
const server = await fixture({ ip, binary, dockerImage });
try {
  const info = await server.call<{ fingerprint: string }>("/api/v1/server/info");
  if (info.payload.fingerprint !== fingerprint(server.ca)) throw new Error("TLS pin mismatch");
  let trustedUnexpectedKey = false;
  try {
    await fetch(server.origin + "/api/v1/server/info", { tls: trusted(server.ca, "unexpected") });
    trustedUnexpectedKey = true;
  } catch {}
  if (trustedUnexpectedKey) throw new Error("The probe accepted an unexpected TLS key");
  const bundle = await Bun.build({ entrypoints: [import.meta.dir + "/browser.ts"], target: "browser", format: "iife" });
  if (!bundle.success) throw new Error("Failed to build the test harness");
  const fingerprintValue = info.payload.fingerprint.slice("sha256/".length);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH,
    args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
      "--ignore-certificate-errors-spki-list=" + fingerprintValue] });
  try {
    const owner = await server.owner();
    if (!owner.account || owner.account.role !== "Owner") throw new Error("Could not bootstrap the owner");
    const moderator = await server.ws(owner);
    const { channelId } = await moderator.rpc<{ channelId: string }>("channel.create", { name: "Other channel" });
    const pages = await Promise.all([browser.newPage(), browser.newPage()]);
    for (const page of pages) {
      page.setDefaultTimeout(8000);
      page.on("console", (entry) => { if (entry.type() === "error") console.error(entry.text()); });
      await page.goto(server.origin + "/api/v1/server/info");
      await page.addScriptTag({ content: await bundle.outputs[0]!.text() });
    }
    const [alice, bob] = pages as [typeof pages[number], typeof pages[number]];
    const [aliceIdentity, bobIdentity] = await Promise.all([
      alice.evaluate(() => window.harness.initialize("Alice")),
      bob.evaluate(() => window.harness.initialize("Bobby")),
    ]);
    if (aliceIdentity.accountId === bobIdentity.accountId) throw new Error("Expected independent accounts");
    const firstProducer = await alice.evaluate((tcp) => window.harness.publish(tcp), forceTcp);
    const measured = await bob.evaluate(({ firstProducer, forceTcp }) => window.harness.consume(firstProducer, forceTcp), { firstProducer, forceTcp });
    if (measured.codec.toLowerCase() !== "audio/opus" || measured.packets <= 0 || measured.protocol !== (forceTcp ? "tcp" : "udp")) {
      throw new Error("Expected Opus over the configured transport");
    }
    const foreignProducer = await bob.evaluate((producerId) =>
      window.harness.rpc("media.producer.pause", { producerId }).then(() => "unexpected success", (error: Error) => error.message), firstProducer);
    const foreignConsumer = await alice.evaluate((consumerId) =>
      window.harness.rpc("media.consumer.pause", { consumerId }).then(() => "unexpected success", (error: Error) => error.message), measured.consumerId);
    if (foreignProducer !== "NOT_FOUND" || foreignConsumer !== "NOT_FOUND") throw new Error("Unexpected media ownership permissions");
    await moderator.rpc("moderation.mute", { connectionId: aliceIdentity.connectionId, muted: true });
    await until(() => bob.evaluate(() => window.harness.events().some(({ type }) => type === "media.producerClosed")), Boolean);
    await moderator.rpc("moderation.mute", { connectionId: aliceIdentity.connectionId, muted: false });
    await alice.evaluate(async () => {
      await window.harness.rpc("channel.leave");
      await window.harness.join();
    });
    const awayProducer = await alice.evaluate((tcp) => window.harness.publish(tcp), forceTcp);
    const bobProducer = await bob.evaluate((tcp) => window.harness.publish(tcp), forceTcp);
    const aliceAudio = await alice.evaluate(({ bobProducer, forceTcp }) => window.harness.consume(bobProducer, forceTcp), { bobProducer, forceTcp });
    const away = await alice.evaluate(() => window.harness.rpc<VoicePresence>(
      "presence.set", { afk: true, afkMessage: "  Back in five  " }));
    if (!away.afk || !away.muted || !away.deafened || away.afkMessage !== "Back in five") throw new Error("AFK state is incomplete");
    await until(() => bob.evaluate((id) => window.harness.events().some(({ type, payload }) =>
      type === "channel.member" && payload.connectionId === id && payload.afk === true && payload.afkMessage === "Back in five"),
    aliceIdentity.connectionId), Boolean);
    const afterAfk = await moderator.rpc<{ producers: number; consumers: number }>("admin.diagnostics");
    if (afterAfk.producers !== 1 || afterAfk.consumers !== 0) throw new Error("AFK left active audio resources");
    const blockedWhileAfk = await alice.evaluate(async ({ producerId, consumerId }) => {
      const resume = (kind: string, payload: object) => window.harness.rpc(kind, payload)
        .then(() => "unexpected success", (error: Error) => error.message);
      return Promise.all([
        resume("media.producer.resume", { producerId }),
        resume("media.consumer.resume", { consumerId }),
      ]);
    }, { producerId: awayProducer, consumerId: aliceAudio.consumerId });
    if (blockedWhileAfk.some((error) => error !== "FORBIDDEN" && error !== "NOT_FOUND")) {
      throw new Error("AFK did not reject a media resume: " + blockedWhileAfk.join(", "));
    }
    const returned = await alice.evaluate(async () => {
      await window.harness.rpc("presence.set", { muted: true });
      return window.harness.rpc<VoicePresence>("presence.set", { afk: false });
    });
    if (returned.afk || !returned.muted || returned.deafened || returned.afkMessage) throw new Error("Returning from AFK did not restore self-mute");
    await alice.evaluate(() => window.harness.rpc("presence.set", { muted: false }));
    await alice.evaluate((channelId) => window.harness.join(channelId), channelId);
    const secondProducer = await alice.evaluate((tcp) => window.harness.publish(tcp), forceTcp);
    const denied = await bob.evaluate(({ secondProducer, forceTcp }) =>
      window.harness.subscribe(secondProducer, forceTcp).then(() => "unexpected success", (error: Error) => error.message),
    { secondProducer, forceTcp });
    if (denied !== "NOT_FOUND") throw new Error("Cross-channel producer ID was accessible: " + denied);
    await bob.evaluate((channelId) => window.harness.join(channelId), channelId);
    await bob.evaluate(({ secondProducer, forceTcp }) => window.harness.consume(secondProducer, forceTcp), { secondProducer, forceTcp });
    const screen = await alice.evaluate((tcp) => window.harness.publishVideo(tcp, "screen"), forceTcp);
    await until(() => bob.evaluate((producerId) => window.harness.events().some(({ type, payload }) =>
      type === "media.screenAvailable" && payload.producerId === producerId), screen), Boolean);
    const screenWidth = await bob.evaluate(({ screen, forceTcp }) => window.harness.consumeVideo(screen, forceTcp, "screen"), { screen, forceTcp });
    if (!screenWidth) throw new Error("No decoded screen video was received");
    const camera = await alice.evaluate((tcp) => window.harness.publishVideo(tcp, "camera"), forceTcp);
    await until(() => bob.evaluate((producerId) => window.harness.events().some(({ type, payload }) =>
      type === "media.cameraAvailable" && payload.producerId === producerId), camera), Boolean);
    const cameraWidth = await bob.evaluate(({ camera, forceTcp }) => window.harness.consumeVideo(camera, forceTcp, "camera"), { camera, forceTcp });
    if (cameraWidth !== 640) throw new Error("Camera video was not decoded at the requested width");
    const wrongTransport = await bob.evaluate(({ camera, forceTcp }) => window.harness.consumeVideo(camera, forceTcp, "screen")
      .then(() => "unexpected success", (error: Error) => error.message), { camera, forceTcp });
    if (wrongTransport !== "NOT_FOUND") throw new Error("Camera video was accessible through the screen transport");
    await alice.evaluate(() => window.harness.stopVideo("screen"));
    await until(() => bob.evaluate((producerId) => window.harness.events().some(({ type, payload }) =>
      type === "media.screenClosed" && payload.producerId === producerId), screen), Boolean);
    const state = await bob.evaluate(() => window.harness.rpc<{ cameras: { producerId: string }[] }>("state.get"));
    if (!state.cameras.some(({ producerId }) => producerId === camera)) throw new Error("Stopping a screen share also stopped the camera");
    await alice.evaluate(() => window.harness.stopVideo("camera"));
    await until(() => bob.evaluate((producerId) => window.harness.events().some(({ type, payload }) =>
      type === "media.cameraClosed" && payload.producerId === producerId), camera), Boolean);
    const previousClosures = await bob.evaluate(() => window.harness.events().filter(({ type }) => type === "media.producerClosed").length);
    await alice.evaluate(async () => { await window.harness.rpc("channel.leave"); });
    await until(() => bob.evaluate(() => window.harness.events().filter(({ type }) => type === "media.producerClosed").length),
      (count) => count > previousClosures);
    await Bun.sleep(250); // Let packets already in the TCP receive buffer drain.
    const afterSwitch = await bob.evaluate(() => window.harness.stats());
    await Bun.sleep(500);
    if (await bob.evaluate(() => window.harness.stats()) > afterSwitch) throw new Error("Audio continued after the sender left");

    await alice.evaluate(() => window.harness.join());
    const { channelId: sourceChannelId } = await alice.evaluate(() => window.harness.rpc<{ channelId: string }>("state.get"));
    await moderator.rpc("channel.join", { channelId: sourceChannelId });
    await moderator.rpc("channel.edit", { channelId, password: "Whisper passphrase" });
    const rejectedWhisper = await alice.evaluate(({ channelId, forceTcp }) => window.harness.publish(forceTcp, { channelId, password: "wrong" })
      .then(() => "unexpected success", (error: Error) => error.message), { channelId, forceTcp });
    if (rejectedWhisper !== "FORBIDDEN") throw new Error("Whisper bypassed the destination password");
    const whisper = await alice.evaluate(({ channelId, forceTcp }) => window.harness.publish(forceTcp, { channelId, password: "Whisper passphrase" }),
      { channelId, forceTcp });
    await bob.evaluate(({ whisper, forceTcp }) => window.harness.consume(whisper, forceTcp), { whisper, forceTcp });
    const sourceProducers = await moderator.rpc<{ producerId: string }[]>("media.producers");
    if (sourceProducers.some(({ producerId }) => producerId === whisper)) throw new Error("Whisper was exposed to the source room");
    const sourceTransport = await moderator.rpc<{ id: string }>("media.transport.create", { direction: "receive", forceTcp });
    const sourceCapabilities = await moderator.rpc("media.capabilities");
    const sourceConsumer = await moderator.rpc("media.consumer.create", {
      transportId: sourceTransport.id, producerId: whisper, rtpCapabilities: sourceCapabilities,
    }).then(() => "unexpected success", (error: Error) => error.message);
    if (!sourceConsumer.includes("NOT_FOUND")) throw new Error("The source room could consume the whisper: " + sourceConsumer);
    await moderator.rpc("media.transport.close", { transportId: sourceTransport.id });
    const targetState = await bob.evaluate(() => window.harness.rpc<{ whispers: { producerId: string; from: string }[] }>("state.get"));
    if (!targetState.whispers.some(({ producerId, from }) => producerId === whisper && from === "Alice")) {
      throw new Error("The destination was not notified of the incoming whisper");
    }
    const publicWhileWhispering = await alice.evaluate(() => window.harness.rpc("media.transport.create", { direction: "send" })
      .then(() => "unexpected success", (error: Error) => error.message));
    if (publicWhileWhispering !== "CONFLICT") throw new Error("The server allowed public transmission during a whisper");
    await moderator.rpc("channel.edit", { channelId, password: null });
    await until(() => alice.evaluate(() => window.harness.events().some(({ type }) => type === "media.whisperEnded")), Boolean);
    await until(() => bob.evaluate((producerId) => window.harness.events().some(({ type, payload }) =>
      type === "media.producerClosed" && payload.producerId === producerId), whisper), Boolean);

    await alice.evaluate((channelId) => window.harness.join(channelId), channelId);
    const producer = await alice.evaluate((tcp) => window.harness.publish(tcp), forceTcp);
    await bob.evaluate(({ producer, forceTcp }) => window.harness.consume(producer, forceTcp), { producer, forceTcp });
    // The raw test socket's account is revoked by a moderator's account ban.
    await moderator.rpc("moderation.ban", { accountId: aliceIdentity.accountId });
    await until(() => alice.evaluate(() => window.harness.closeCode()), (code) => code === 4401);
    await until(() => bob.evaluate((producerId) => window.harness.events().some(({ type, payload }) =>
      type === "media.producerClosed" && payload.producerId === producerId), producer), Boolean);
    const final = await moderator.rpc<{ producers: number; consumers: number }>("admin.diagnostics");
    if (final.producers || final.consumers) throw new Error("Media resources survived session revocation");
    console.log(`Authenticated ${dockerImage ? "Docker" : binary ? "standalone" : "source"} Opus over ${measured.protocol!.toUpperCase()} at ${ip}`,
      { peak: measured.peak, codec: measured.codec, packets: measured.packets },
      "Verified mute, AFK, cross-channel isolation, private whisper routing, channel switching, revocation, screen video and camera video.");
    moderator.close();
  } finally { await browser.close(); }
} finally { await server.cleanup(); }
