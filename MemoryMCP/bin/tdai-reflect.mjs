#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { main } = await import(pathToFileURL(resolve(root, "dist/reflect/cli.js")).href);

// process.exitCode (not process.exit) so stdout flushes when piped.
process.exitCode = await main(process.argv.slice(2), process.env);
