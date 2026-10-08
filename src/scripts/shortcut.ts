// src/scripts/shortcut.ts
// Usage: npm run shortcut → "Job Agent" icon on the desktop (and Start menu / app launcher) that starts the GUI.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = process.cwd();

function windows(): string[] {
  // Paths go in through environment variables, not string-built PowerShell (⚠ Security: no quoting/injection issues)
  const script = `
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell
$made = @()
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
  $lnk = $shell.CreateShortcut((Join-Path $dir 'Job Agent.lnk'))
  $lnk.TargetPath = $env:JA_TARGET
  $lnk.WorkingDirectory = $env:JA_ROOT
  $lnk.IconLocation = $env:JA_ICON
  $lnk.Description = 'Job Agent - job search pipeline and application tracker'
  $lnk.WindowStyle = 7
  $lnk.Save()
  $made += $lnk.FullName
}
$made -join [Environment]::NewLine`;
  const res = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    env: { ...process.env, JA_TARGET: join(ROOT, "start-job-agent.cmd"), JA_ROOT: ROOT, JA_ICON: join(ROOT, "assets", "job-agent.ico") },
    encoding: "utf8",
    windowsHide: true,
  });
  if (res.status !== 0) throw new Error(`PowerShell failed: ${(res.stderr || res.stdout || String(res.error)).trim()}`);
  return res.stdout.trim().split(/\r?\n/);
}

function mac(): string[] {
  const file = join(homedir(), "Desktop", "Job Agent.command");
  writeFileSync(file, `#!/bin/bash\ncd ${JSON.stringify(ROOT)} && ./start-job-agent.sh\n`, "utf8");
  chmodSync(file, 0o755);
  return [file];
}

function linux(): string[] {
  const entry = [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Job Agent",
    "Comment=Job search pipeline and application tracker",
    `Exec=bash -c 'cd "${ROOT.replace(/'/g, "")}" && ./start-job-agent.sh'`,
    `Icon=${join(ROOT, "assets", "job-agent.png")}`,
    "Terminal=true",
    "Categories=Office;Development;",
    "",
  ].join("\n");
  const made: string[] = [];
  const apps = join(homedir(), ".local", "share", "applications");
  mkdirSync(apps, { recursive: true });
  for (const dir of [apps, join(homedir(), "Desktop")]) {
    if (!existsSync(dir)) continue;
    const file = join(dir, "job-agent.desktop");
    writeFileSync(file, entry, "utf8");
    chmodSync(file, 0o755);
    spawnSync("gio", ["set", file, "metadata::trusted", "true"], { stdio: "ignore" }); // GNOME: allow launching
    made.push(file);
  }
  return made;
}

export function createShortcut(): string[] {
  if (!existsSync(resolve(ROOT, "start-job-agent.cmd")) || !existsSync(resolve(ROOT, "assets"))) {
    throw new Error("Run this from the job-agent folder.");
  }
  return process.platform === "win32" ? windows() : process.platform === "darwin" ? mac() : linux();
}

if (process.argv[1]?.endsWith("shortcut.ts")) {
  try {
    const made = createShortcut();
    console.log(`✔ Shortcut created:\n  ${made.join("\n  ")}\nDouble-click "Job Agent" to start.`);
  } catch (err: unknown) {
    console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
