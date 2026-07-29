import { execFile as executeFile } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(executeFile);

/**
 * Opens the platform's directory picker. The selected path stays inside the
 * loopback service; callers must never return it to the browser.
 */
export async function selectNativeLibraryDirectory(): Promise<string | undefined> {
  const result = process.platform === "darwin"
    ? await execFile("osascript", [
      "-e",
      'try\nPOSIX path of (choose folder with prompt "选择要添加到 Routego 图库的文件夹")\non error number -128\nreturn ""\nend try'
    ], { encoding: "utf8", maxBuffer: 16 * 1024 })
    : process.platform === "win32"
      ? await execFile("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = '选择要添加到 Routego 图库的文件夹'; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }"
      ], { encoding: "utf8", maxBuffer: 16 * 1024 })
      : await execFile("zenity", [
        "--file-selection",
        "--directory",
        "--title=选择要添加到 Routego 图库的文件夹"
      ], { encoding: "utf8", maxBuffer: 16 * 1024 });
  const selected = result.stdout.trim();
  return selected === "" ? undefined : selected;
}
