import { cli } from "./cli";

try { await cli(process.argv.slice(2)); }
catch (error) {
  console.error(error instanceof Error ? error.message : "Server failed to start");
  process.exitCode = 1;
}
