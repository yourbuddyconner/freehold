import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeOpenApi } from "../src/openapi.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const outPath = join(__dirname, "..", "openapi.json");
writeOpenApi(outPath);
