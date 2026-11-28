import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const run = promisify(execFile);
const frameBytes = 4; // Stereo signed 16-bit PCM at 48 kHz.
const bufferBytes = 48000 * frameBytes / 5;
const maxRecordersPerShare = 32;
const maxRecorders = 128;

async function pulseList(kind) {
  const { stdout } = await run("pactl", ["--format=json", "list", kind], { timeout: 3000, maxBuffer: 2 ** 20 });
  return JSON.parse(stdout);
}

function record(index, monitor) {
  const child = spawn("parec", [
    "--raw", "--format=s16le", "--rate=48000", "--channels=2", "--latency-msec=20",
    `--monitor-stream=${index}`, `--device=${monitor}`, "--client-name=Korero.chat",
    // Keep PipeWire bound to the selected stream when it vanishes or is moved.
    "--property=node.dont-fallback=true", "--property=node.dont-reconnect=true", "--property=node.dont-move=true",
  ], { stdio: ["ignore", "pipe", "ignore"] });
  const ready = new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  let pending = Buffer.alloc(0);
  let ended = false;
  const end = () => { ended = true; pending = Buffer.alloc(0); };
  child.on("error", end);
  child.on("close", end);
  child.stdout.on("error", end);
  child.stdout.on("data", (chunk) => {
    if (ended) return;
    pending = Buffer.concat([pending, chunk]);
    const overflow = pending.length - bufferBytes;
    if (overflow > 0) pending = pending.subarray(Math.ceil(overflow / frameBytes) * frameBytes);
  });
  return {
    ready,
    read() {
      if (ended) return null;
      const size = pending.length - pending.length % frameBytes;
      const data = Uint8Array.from(pending.subarray(0, size)).buffer;
      pending = pending.subarray(size);
      return data;
    },
    stop() { end(); child.kill(); },
  };
}

export class ApplicationAudio {
  #sessions = new Map();
  #generation = 0;

  constructor(ownProcesses) {
    this.ownProcesses = ownProcesses;
  }

  async #applications() {
    if (process.platform !== "linux") throw new Error("Application audio is available on Linux desktop.");
    const [inputs, sinks] = await Promise.all([pulseList("sink-inputs"), pulseList("sinks")]).catch(() => {
      throw new Error("Application audio requires PulseAudio or PipeWire with pactl and parec installed.");
    });
    const monitors = new Map(sinks.map(({ index, monitor_source }) => [String(index), monitor_source]));
    const ownProcesses = new Set(this.ownProcesses().map(String));
    const applications = new Map();
    for (const { index, sink, properties = {} } of inputs) {
      const monitor = monitors.get(String(sink));
      const binary = properties["application.process.binary"];
      const name = properties["application.name"] || binary || properties["node.name"];
      if (!name || !monitor?.endsWith(".monitor") || !Number.isSafeInteger(index) ||
          ownProcesses.has(properties["application.process.id"]) || name === "Korero.chat" || binary === "korero-chat-frontend") continue;
      const id = JSON.stringify([binary ?? "", name]);
      const application = applications.get(id) ?? { id, name, inputs: [] };
      application.inputs.push({ index, monitor });
      applications.set(id, application);
    }
    return applications;
  }

  async list() {
    const applications = await this.#applications();
    return Array.from(applications.values(), ({ id, name }) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }

  async start(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > maxRecordersPerShare || ids.some((id) => typeof id !== "string")) {
      throw new Error("Choose at least one application to share.");
    }
    const generation = this.#generation;
    const applications = await this.#applications();
    if (generation !== this.#generation) throw new Error("Application audio setup ended.");
    const streams = [];
    for (const id of new Set(ids)) {
      const application = applications.get(id);
      if (!application) throw new Error("An application stopped playing audio. Refresh the application list and try again.");
      for (const input of application.inputs) streams.push({ ...input, application: id });
    }
    const active = Array.from(this.#sessions.values()).reduce((count, session) => count + session.length, 0);
    if (streams.length > maxRecordersPerShare || streams.length + active > maxRecorders) {
      throw new Error("Too many application audio streams are selected.");
    }
    const id = randomUUID();
    const recorders = streams.map(({ index, monitor }) => record(index, monitor));
    this.#sessions.set(id, recorders);
    try {
      await Promise.all(recorders.map(({ ready }) => ready));
      if (!this.#sessions.has(id)) throw new Error("Application audio setup ended.");
      return { id, applications: streams.map(({ application }) => application) };
    } catch (error) {
      this.stop(id);
      if (error.code === "ENOENT") throw new Error("Install parec to share application audio.");
      throw error;
    }
  }

  read(id) { return this.#sessions.get(id)?.map((recorder) => recorder.read()); }

  stop(id) {
    const session = this.#sessions.get(id);
    this.#sessions.delete(id);
    for (const recorder of session ?? []) recorder.stop();
  }

  reset() {
    this.#generation++;
    for (const id of this.#sessions.keys()) this.stop(id);
  }
}
