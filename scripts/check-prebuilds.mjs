import { statSync } from "node:fs";

for (const platform of ["linux", "darwin", "win32"]) {
  for (const arch of ["x64", "arm64"]) {
    const path = new URL(
      `../prebuilds/${platform}-${arch}/file-lock.node`,
      import.meta.url,
    );
    if (!statSync(path).isFile())
      throw new Error(`Missing native lock binary: ${path}`);
  }
}
