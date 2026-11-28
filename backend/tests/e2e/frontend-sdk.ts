import assert from "node:assert/strict";
import { resolve, sep } from "node:path";
import { chromium, type Browser, type Page, _electron as electron } from "playwright";
import { fixture, until } from "../server";
import { fingerprint } from "../../src/security/tls";
import { LOBBY } from "../../src/database";

const frontend = resolve(import.meta.dir, "../../../frontend");
const dist = resolve(frontend, "dist");
if (!await Bun.file(resolve(dist, "index.html")).exists()) {
  throw new Error("Build the frontend with bun run build before running this test.");
}
const web = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = resolve(dist, "." + new URL(request.url).pathname);
  if (path !== dist && !path.startsWith(dist + sep)) return new Response(null, { status: 404 });
  const file = Bun.file(path);
  return new Response(path !== dist && await file.exists() ? file : Bun.file(resolve(dist, "index.html")));
} });
const webOrigin = "http://127.0.0.1:" + web.port;
const pageErrors: string[] = [];
let browser: Browser | undefined;
let desktop: Awaited<ReturnType<typeof electron.launch>> | undefined;
let server: Awaited<ReturnType<typeof fixture>> | undefined;

const exactButton = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const menuItem = (page: Page, name: string) => page.locator('[data-slot="context-menu-content"][data-state="open"]')
  .getByRole("menuitem", { name, exact: true });
const channelLog = (page: Page) => page.getByRole("log", { name: "Channel messages" });
const directLog = (page: Page) => page.getByRole("log", { name: "Direct messages" });

function monitor(page: Page) {
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
}

function observeSuccessfulRequest(page: Page, kind: string, received: () => void) {
  page.on("websocket", (socket) => {
    const pending = new Set<number>();
    socket.on("framesent", ({ payload }) => {
      if (typeof payload !== "string") return;
      const frame = JSON.parse(payload);
      if (frame.type === kind) pending.add(frame.id);
    });
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") return;
      const frame = JSON.parse(payload);
      if (frame.type === "response" && pending.delete(frame.id) && frame.success === true) received();
    });
  });
}

async function enroll(page: Page, name: string, address: string, setupToken?: string, native = false) {
  monitor(page);
  if (!native) await page.goto(webOrigin);
  await exactButton(page, "Continue without an account").click();
  await page.getByRole("textbox", { name: "Username" }).fill(name);
  await exactButton(page, "Continue").click();
  await exactButton(page, "Connect to server").click();
  await page.getByRole("textbox", { name: "Server address or invitation link" }).fill(address);
  await exactButton(page, "Connect").click();
  if (native) await exactButton(page, "Trust and continue").click();
  if (setupToken) {
    await page.getByLabel("Server setup token").fill(setupToken);
    await exactButton(page, "Set up server").click();
  }
  await page.getByRole("heading", { name: "Lobby", exact: true }).waitFor();
}

async function send(page: Page, text: string, direct = false) {
  const composer = page.getByRole("textbox", { name: direct ? "Encrypted message" : "Channel message" });
  await composer.and(page.locator('textarea, input, [contenteditable="true"]')).fill(text);
  await exactButton(page, direct ? "Send direct message" : "Send message").click();
}

async function edit(page: Page, text: string, next: string, direct = false) {
  const log = direct ? directLog(page) : channelLog(page);
  await log.getByText(text, { exact: true }).click({ button: "right" });
  await menuItem(page, "Edit message").click();
  await page.getByRole("textbox", { name: "Edit message" }).fill(next);
  await exactButton(page, "Save").click();
  await log.getByText(next, { exact: true }).waitFor();
}

async function remove(page: Page, text: string, direct = false) {
  const log = direct ? directLog(page) : channelLog(page);
  await log.getByText(text, { exact: true }).click({ button: "right" });
  await menuItem(page, "Delete message").click();
  await exactButton(page, "Delete").click();
  await log.getByText(text, { exact: true }).waitFor({ state: "hidden" });
}

async function safetyCode(page: Page, peer: string) {
  await page.getByRole("button", { name: /^Direct messages/ }).click();
  await page.getByRole("button", { name: new RegExp(peer + ".*Online") }).click();
  await exactButton(page, "Verify safety code").click();
  return (await page.getByRole("dialog", { name: "Compare safety codes" }).locator(".key-display").textContent())!.trim();
}

async function verify(page: Page, code: string) {
  const dialog = page.getByRole("dialog", { name: "Compare safety codes" });
  await dialog.getByLabel("Safety code from your contact").fill(code);
  await dialog.getByRole("button", { name: "Verify safety code", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
}

try {
  server = await fixture({ environment: {
    VOICE_SERVER_NAME: "SDK Test Server",
    VOICE_SERVER_ORIGINS: JSON.stringify([webOrigin]),
    VOICE_SERVER_REGISTRATION: "open",
    VOICE_AUTHENTICATION_ACCESS_SECONDS: "25",
    VOICE_MESSAGING_PER_MINUTE: "125",
  } });
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    args: ["--ignore-certificate-errors-spki-list=" + fingerprint(server.ca).slice("sha256/".length)],
  });
  const alice = await browser.newPage({ acceptDownloads: true });
  const bobContext = await browser.newContext({ acceptDownloads: true });
  const bob = await bobContext.newPage();
  const signals = new Set<string>();
  observeSuccessfulRequest(alice, "connection.renew", () => signals.add("renew"));
  alice.on("response", (response) => {
    if (response.ok() && response.url().endsWith("/api/v1/auth/refresh")) signals.add("refresh");
  });
  await enroll(alice, "Alice SDK", server.origin, server.setupToken);
  await enroll(bob, "Bobby SDK", server.origin);
  console.log("PASS local key generation, owner bootstrap, and member enrollment");

  await send(alice, "SDK channel original");
  await channelLog(bob).getByText("SDK channel original", { exact: true }).waitFor();
  await edit(alice, "SDK channel original", "SDK channel edited");
  await channelLog(bob).getByText("SDK channel edited", { exact: true }).waitFor();
  await remove(alice, "SDK channel edited");
  await channelLog(bob).getByText("SDK channel edited", { exact: true }).waitFor({ state: "hidden" });
  await exactButton(alice, "Join channel").click();
  await exactButton(alice, "Leave channel").click();
  await exactButton(alice, "Join channel").waitFor();
  console.log("PASS channel subscription, live send/edit/delete, join, and leave");

  async function setPin(text: string, pinned: boolean) {
    await channelLog(alice).getByText(text, { exact: true }).click({ button: "right" });
    await menuItem(alice, pinned ? "Pin message" : "Unpin message").click();
  }

  await send(alice, "First pinned message");
  await setPin("First pinned message", true);
  const historySender = await server.ws(await server.register("History sender"));
  try {
    for (let index = 1; index <= 100; index++) {
      await historySender.rpc("message.send", { channelId: LOBBY, text: `History message ${index}` });
    }
  } finally {
    historySender.close();
  }
  await send(alice, "Second pinned message");
  await setPin("Second pinned message", true);
  await bob.reload();
  await channelLog(bob).getByText("Second pinned message", { exact: true }).waitFor();
  assert.equal(await channelLog(bob).getByText("First pinned message", { exact: true }).count(), 0);
  const pins = bob.getByRole("dialog", { name: "Pinned messages" });
  const pinRow = (text: string) => pins.getByRole("listitem").filter({ hasText: text });
  await exactButton(bob, "Pinned messages").click();
  await pinRow("First pinned message").getByRole("button", { name: "Go to message" }).click();
  const jumped = channelLog(bob).getByRole("article").filter({ hasText: "First pinned message" });
  await jumped.waitFor();
  assert.ok(await jumped.evaluate((message) => document.activeElement === message));
  await exactButton(bob, "Back to latest").click();
  await exactButton(bob, "Pinned messages").click();
  await pinRow("Second pinned message").waitFor();
  await setPin("Second pinned message", false);
  await pinRow("Second pinned message").waitFor({ state: "hidden" });
  await remove(alice, "First pinned message");
  await pins.getByText("No pinned messages.", { exact: true }).waitFor();
  await exactButton(bob, "Close dialog").click();
  console.log("PASS multiple channel pins, a channel reader's jump to old history, and live unpin and deletion");

  await until(() => exactButton(alice, "Attach file").isEnabled(), Boolean);
  await alice.locator(".composer input[type=file]").setInputFiles({
    name: "sdk-e2e.txt", mimeType: "text/plain", buffer: Buffer.from("SDK attachment round trip"),
  });
  await exactButton(alice, "Send message").click();
  const download = bob.waitForEvent("download");
  await exactButton(bob, "sdk-e2e.txt").click();
  const downloaded = await download;
  assert.equal(downloaded.suggestedFilename(), "sdk-e2e.txt");
  assert.equal(await Bun.file((await downloaded.path())!).text(), "SDK attachment round trip");
  console.log("PASS attachment upload and cross-client download with byte equality");

  const codes = await Promise.all([safetyCode(alice, "Bobby SDK"), safetyCode(bob, "Alice SDK")]);
  assert.match(codes[0]!, /[a-f0-9]/i);
  assert.equal(codes[0], codes[1]);
  await Promise.all([verify(alice, codes[1]!), verify(bob, codes[0]!)]);
  await send(alice, "SDK private original", true);
  await directLog(bob).getByText("SDK private original", { exact: true }).waitFor();
  await edit(alice, "SDK private original", "SDK private edited", true);
  await directLog(bob).getByText("SDK private edited", { exact: true }).waitFor();
  await remove(alice, "SDK private edited", true);
  await directLog(bob).getByText("SDK private edited", { exact: true }).waitFor({ state: "hidden" });
  console.log("PASS direct-peer lookup, safety-code verification, encrypted send/edit/delete");

  await bob.close();
  await alice.getByText("This contact is offline. The server delivers your messages when they next connect.").waitFor();
  await send(alice, "SDK queued offline", true);
  await directLog(alice).getByText("SDK queued offline", { exact: true }).waitFor();
  const returnedBob = await bobContext.newPage();
  monitor(returnedBob);
  observeSuccessfulRequest(returnedBob, "direct.ack", () => signals.add("ack"));
  await returnedBob.goto(webOrigin);
  await returnedBob.getByRole("button", { name: /^Direct messages/ }).click();
  await returnedBob.getByRole("button", { name: /Alice SDK.*Online/ }).click();
  await directLog(returnedBob).getByText("SDK queued offline", { exact: true }).waitFor();
  await until(() => signals.has("ack"), Boolean);
  console.log("PASS offline direct-message queue, reconnect, acknowledgement, and saved safety code");

  await returnedBob.reload();
  await returnedBob.getByRole("button", { name: /^Direct messages/ }).waitFor();
  await returnedBob.getByRole("link", { name: "Account settings" }).click();
  await returnedBob.getByRole("textbox", { name: "Display name" }).fill("Bobby Renamed");
  await exactButton(returnedBob, "Save name").click();
  await returnedBob.getByText("Display name updated.").waitFor();
  const profile = returnedBob.getByRole("region", { name: "Profile picture" });
  const profileFile = profile.locator("input[type=file]");
  await until(() => profileFile.isEnabled(), Boolean);
  const png = await returnedBob.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 32;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#117575";
    context.fillRect(0, 0, 32, 32);
    return canvas.toDataURL("image/png").slice("data:image/png;base64,".length);
  });
  await profileFile.setInputFiles({
    name: "sdk-profile.png", mimeType: "image/png",
    buffer: Buffer.from(png, "base64"),
  });
  const pictureUpdate = profile.getByText("Profile picture updated.").or(profile.getByRole("alert"));
  assert.equal(await pictureUpdate.textContent(), "Profile picture updated.");
  const picture = returnedBob.waitForResponse((res) => res.ok() && /\/api\/v1\/account\/picture\//.test(res.url()));
  await returnedBob.reload();
  const { avatarId, data } = await (await picture).json();
  assert.ok(avatarId && data);
  await exactButton(returnedBob, "Remove picture").click();
  await returnedBob.getByText("Profile picture removed.").waitFor();
  console.log("PASS profile picture upload, reload and download, and removal");
  await alice.getByRole("button", { name: "Server settings", exact: true }).click();
  await alice.getByLabel("Message of the day").fill("SDK administration verified");
  await exactButton(alice, "Save settings").click();
  await alice.getByText("Server settings saved.").waitFor();
  await exactButton(alice, "Users").click();
  await alice.getByText("Bobby Renamed", { exact: true }).waitFor();
  await exactButton(alice, "Audit log").click();
  await alice.getByText("Updated message of the day", { exact: true }).waitFor();
  await exactButton(alice, "Users").click();
  await exactButton(alice, "Ban Bobby Renamed").click();
  await alice.getByRole("combobox", { name: "Ban for Bobby Renamed expires after" }).click();
  await alice.getByRole("option", { name: "1 hour", exact: true }).click();
  await exactButton(alice, "Confirm ban").click();
  await alice.getByText("Banned Bobby Renamed.").waitFor();
  await exactButton(alice, "Audit log").click();
  const response = alice.waitForResponse((res) => res.ok() && res.url().endsWith("/api/v1/admin/accounts"));
  await exactButton(alice, "Users").click();
  const { accounts } = await (await response).json() as { accounts: { displayName: string; bannedUntil?: number | null }[] };
  const bannedUntil = accounts.find(({ displayName }) => displayName === "Bobby Renamed")?.bannedUntil;
  assert.ok(bannedUntil && bannedUntil > Date.now());
  await alice.getByText(/^Banned until /).waitFor();
  await exactButton(alice, "Unban Bobby Renamed").click();
  await exactButton(alice, "Confirm unban").click();
  await alice.getByText("Unbanned Bobby Renamed.").waitFor();
  await exactButton(alice, "Invitations").click();
  await exactButton(alice, "Create invitation").click();
  await alice.getByRole("textbox", { name: "Invitation link" }).waitFor();
  assert.ok((await alice.getByRole("textbox", { name: "Invitation link" }).inputValue()).startsWith(server.origin + "#"));
  console.log("PASS timed ban survives re-fetch, unban succeeds, invitation is created");
  await until(() => signals.has("refresh") && signals.has("renew"), Boolean, 25000);
  console.log("PASS access-token refresh and live socket renewal");
  console.log("PASS browser reload and session recovery, profile PATCH, settings PATCH, users and audit GET");

  if (process.argv.includes("--desktop")) {
    desktop = await electron.launch({
      executablePath: require(resolve(frontend, "node_modules/electron")),
      args: [frontend, "--user-data-dir=" + resolve(server.directory, "electron")],
    });
    const page = await desktop.firstWindow();
    await enroll(page, "Electron SDK", server.origin, undefined, true);
    await send(page, "SDK desktop mail");
    await channelLog(page).getByText("SDK desktop mail", { exact: true }).waitFor();
    await exactButton(page, "Pinned messages").click();
    await page.getByRole("dialog", { name: "Pinned messages" }).getByText("No pinned messages.").waitFor();
    await exactButton(page, "Close dialog").click();
    await page.getByRole("link", { name: "Account settings" }).click();
    await page.getByRole("textbox", { name: "Display name" }).fill("Electron Renamed");
    await exactButton(page, "Save name").click();
    await page.getByText("Display name updated.").waitFor();
    console.log("PASS Electron certificate approval, desktop chat, and SDK HTTP through IPC");
  }

  assert.deepEqual(pageErrors, []);
} finally {
  await desktop?.close();
  await browser?.close();
  await server?.cleanup();
  web.stop(true);
}
