import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "naavos-browser-"));
process.env.RADOS_HOME = isolatedHome;
process.env.RADOSS_NO_OPEN = "1";
const { createSetupServer } = await import("../lib/setup-runtime.mjs");
const { server } = await createSetupServer({ port: 4107, open: false });
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, () => {
    server.close(() => {
      fs.rmSync(isolatedHome, { recursive: true, force: true });
      process.exit(0);
    });
  });
