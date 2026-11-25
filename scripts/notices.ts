import { copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { workerBuildPolicy } from "../src/security/files";
import { dependencies } from "../package.json";

const root = resolve(import.meta.dir, "..");
const out = resolve(process.argv[2] ?? join(root, "dist", "licenses"));
await mkdir(out, { recursive: true });
for (const name of await readdir(join(root, "licenses"))) await copyFile(join(root, "licenses", name), join(out, name));
const seen = new Set<string>();
const index: string[] = [];
async function include(name: string, from: string) {
  for (let parent = from; parent.startsWith(root); parent = dirname(parent)) {
    const location = join(parent, "node_modules", name);
    const file = Bun.file(join(location, "package.json"));
    if (!await file.exists()) continue;
    const pkg = await file.json() as { version: string; license?: string; dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
    const key = `${name}@${pkg.version}`;
    if (seen.has(key)) return;
    seen.add(key);
    index.push(`${key} ${pkg.license ?? "(see package licence)"}`);
    for (const notice of await readdir(location)) {
      if (/^(licen[cs]e|copying|notice)([._-]|$)/i.test(notice) && (await Bun.file(join(location, notice)).exists())) {
        await copyFile(join(location, notice), join(out, `${key.replace("/", "__")}-${notice}`));
      }
    }
    for (const dependency of Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies })) await include(dependency, location);
    return;
  }
}
for (const name of Object.keys(dependencies)) await include(name, root);

const workerSubprojects = join(root, "node_modules", "mediasoup", "worker", "out", workerBuildPolicy, "source", "subprojects");
for (const name of await readdir(workerSubprojects)) {
  if (!/^(libuv-v|libsrtp-|flatbuffers-|unordered_dense-)/.test(name)) continue;
  const directory = join(workerSubprojects, name);
  for (const notice of await readdir(directory)) {
    if (/^(licen[cs]e|copying|notice)([._-]|$)/i.test(notice)) {
      await copyFile(join(directory, notice), join(out, `${name}-${notice}`));
    }
  }
}
await Bun.write(join(out, "npm-packages.txt"), index.sort().join("\n") + "\n");
