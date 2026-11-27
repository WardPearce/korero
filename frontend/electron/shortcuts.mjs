const modifiers = new Map([["Shift", 1], ["Control", 4], ["Alt", 8], ["Super", 64]]);
const keys = /^(?:Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space)$/;

function keysym(code) {
  if (code === "Space") return 32;
  if (code.startsWith("F")) return 0xffbd + Number(code.slice(1));
  return code.at(-1).toLowerCase().charCodeAt(0);
}

export class TalkShortcut {
  #current;
  #queue = Promise.resolve();

  configure(shortcut, notify) {
    const task = this.#queue.then(() => this.#configure(shortcut, notify));
    this.#queue = task.catch(() => {});
    return task;
  }

  async #configure(shortcut, notify) {
    if (this.#current?.shortcut === shortcut) return;
    this.close();
    if (shortcut == null) return;
    if (process.platform !== "linux" || !process.env.DISPLAY) {
      throw new Error("System-wide shortcuts are unavailable. The shortcut works while Korero.chat is focused.");
    }
    const parts = typeof shortcut === "string" ? shortcut.split("+") : [];
    const key = parts.pop();
    if (!key || !keys.test(key) || (!parts.length && !key.startsWith("F")) ||
        new Set(parts).size !== parts.length || parts.some((name) => !modifiers.has(name))) {
      throw new Error("Invalid system-wide talk shortcut.");
    }
    const { default: x11 } = await import("x11");
    const display = await new Promise((resolve, reject) => x11.createClient({ disableBigRequests: true },
      (error, connection) => error ? reject(error) : resolve(connection)));
    const client = display.client;
    const root = display.screen[0].root;
    const query = (name, ...args) => new Promise((resolve, reject) =>
      client[name](...args, (error, result) => error ? reject(error) : resolve(result)));
    let held;
    let release;
    let grabError;
    const close = () => {
      clearTimeout(release);
      if (held !== undefined) notify({ shortcut, pressed: false });
      held = undefined;
      client.terminate();
    };
    const registration = { shortcut, close };
    const failed = (error) => {
      grabError ??= error;
      if (this.#current === registration) this.close();
    };
    client.on("error", failed);
    client.on("end", () => failed(new Error("The X11 connection closed.")));
    try {
      const first = display.min_keycode;
      const [layout, mapping] = await Promise.all([
        query("GetKeyboardMapping", first, display.max_keycode - first + 1), query("GetModifierMapping"),
      ]);
      const codes = layout.flatMap((symbols, index) => symbols.includes(keysym(key)) ? [first + index] : []);
      if (!codes.length) throw new Error("The shortcut key is unavailable on the current keyboard.");
      const mask = parts.reduce((value, name) => value | modifiers.get(name), 0);
      const locks = [0xffe5, 0xff7f, 0xff14]; // Caps Lock, Num Lock and Scroll Lock.
      const masks = new Set([mask]);
      for (const [index, group] of mapping.entries()) {
        if (group.some((code) => layout[code - first]?.some((symbol) => locks.includes(symbol)))) {
          for (const value of [...masks]) masks.add(value | (1 << index));
        }
      }
      for (const code of codes) for (const value of masks) client.GrabKey(root, false, value, code, 1, 1);
      await client.sync();
      if (grabError) throw new Error("Could not register the system-wide shortcut. It may already be in use.");
      client.on("event", ({ name, keycode }) => {
        if (this.#current !== registration || !codes.includes(keycode)) return;
        if (name === "KeyPress") {
          clearTimeout(release);
          if (held === undefined) notify({ shortcut, pressed: true });
          held = keycode;
        } else if (name === "KeyRelease" && keycode === held) {
          // An X11 repeat is a release followed immediately by another press.
          clearTimeout(release);
          release = setTimeout(() => { held = undefined; notify({ shortcut, pressed: false }); }, 25);
        }
      });
      this.#current = registration;
    } catch (error) {
      close();
      throw error;
    }
  }

  close() {
    const current = this.#current;
    this.#current = undefined;
    current?.close();
  }
}
