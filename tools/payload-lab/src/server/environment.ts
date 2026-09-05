import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export const root = fileURLToPath(new URL("../../../../", import.meta.url));
const envPath = join(root, ".env");
if (existsSync(envPath)) loadEnvFile(envPath);
