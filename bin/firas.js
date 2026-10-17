#!/usr/bin/env node
// Entry point. Kept tiny and syntax-conservative so an old Node prints a clear message instead of a stack trace.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 18 || (major === 18 && minor < 17)) {
  process.stderr.write("Firas Code 2 needs Node.js 18.17 or newer (found " + process.versions.node + ").\n");
  process.exit(1);
}
const { main } = await import("../src/cli.js");
await main(process.argv.slice(2));
