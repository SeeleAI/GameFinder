import { cp, mkdir } from "node:fs/promises";
import path from "node:path";

const source = path.resolve("src", "save", "recipes", "built-in");
const target = path.resolve("dist", "save", "recipes", "built-in");

await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true, force: true });
