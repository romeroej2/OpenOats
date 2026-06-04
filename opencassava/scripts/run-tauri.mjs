import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import "./sync-version.mjs";

const args = process.argv.slice(2);
const isBuild = args.includes("build");
const powershell = process.platform === "win32" ? "powershell.exe" : "pwsh";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, "..");
const workspaceRoot = path.resolve(appRoot, "..");

function resolveTauriCommand(commandArgs) {
  // Spawn the Tauri CLI's JS entrypoint with the current Node binary instead of
  // the platform .cmd/.sh shims. This avoids shelling out through cmd.exe on
  // Windows (no argument quoting, no shell injection surface) and behaves
  // identically on every platform.
  const tauriCliCandidates = [appRoot, workspaceRoot].map((root) =>
    path.join(root, "node_modules", "@tauri-apps", "cli", "tauri.js"),
  );

  const tauriCli = tauriCliCandidates.find((candidate) => existsSync(candidate));
  if (!tauriCli) {
    throw new Error(
      `Unable to find the Tauri CLI in ${appRoot} or ${workspaceRoot}. Run npm install in one of those directories.`,
    );
  }

  return [process.execPath, [tauriCli, ...commandArgs]];
}

const tauriCommand = resolveTauriCommand(args);

function run(command, commandArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      stdio: "inherit",
      shell: false,
    });

    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} exited with signal ${signal}`));
        return;
      }
      resolve(code ?? 0);
    });
    child.on("error", reject);
  });
}

async function main() {
  const prepareArgs = ["-ExecutionPolicy", "Bypass", "-File", "./scripts/prepare-whisper.ps1"];
  const cleanupArgs = ["-ExecutionPolicy", "Bypass", "-File", "./scripts/cleanup-whisper.ps1"];

  await run(powershell, prepareArgs);

  let exitCode = 0;
  try {
    exitCode = await run(tauriCommand[0], tauriCommand[1]);
  } finally {
    if (isBuild) {
      await run(powershell, cleanupArgs);
    }
  }

  process.exit(exitCode);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
