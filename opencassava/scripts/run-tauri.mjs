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

function quoteWindowsArg(arg) {
  if (!arg.length) {
    return "\"\"";
  }

  return /[\s"]/u.test(arg) ? `"${arg.replace(/"/g, "\\\"")}"` : arg;
}

function resolveTauriCommand(commandArgs) {
  const tauriCandidates = process.platform === "win32"
    ? [
        path.join(appRoot, "node_modules", ".bin", "tauri.cmd"),
        path.join(workspaceRoot, "node_modules", ".bin", "tauri.cmd"),
      ]
    : [
        path.join(appRoot, "node_modules", ".bin", "tauri"),
        path.join(workspaceRoot, "node_modules", ".bin", "tauri"),
      ];

  const tauriBinary = tauriCandidates.find((candidate) => existsSync(candidate));
  if (!tauriBinary) {
    throw new Error(
      `Unable to find the Tauri CLI in ${appRoot} or ${workspaceRoot}. Run npm install in one of those directories.`,
    );
  }

  if (process.platform === "win32") {
    const command = [quoteWindowsArg(tauriBinary), ...commandArgs.map(quoteWindowsArg)].join(" ");
    return ["cmd.exe", ["/d", "/s", "/c", command]];
  }

  return [tauriBinary, commandArgs];
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
