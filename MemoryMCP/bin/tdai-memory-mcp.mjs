#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await import(pathToFileURL(resolve(root, "dist/main.js")).href);
