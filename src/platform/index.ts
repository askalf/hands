import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

export type Platform = 'darwin' | 'linux' | 'win32';
export type DisplayServer = 'x11' | 'wayland' | 'quartz' | 'win32';

export function getPlatform(): Platform {
  return process.platform as Platform;
}

export function getDisplayServer(): DisplayServer {
  const platform = getPlatform();
  if (platform === 'darwin') return 'quartz';
  if (platform === 'win32') return 'win32';
  // Linux: check for Wayland
  if (process.env['WAYLAND_DISPLAY']) return 'wayland';
  return 'x11';
}

export async function commandExists(cmd: string): Promise<boolean> {
  try {
    const which = getPlatform() === 'win32' ? 'where' : 'which';
    await execFileAsync(which, [cmd]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the ydotoold Unix-socket path the same way the ydotool client does:
 * an explicit `YDOTOOL_SOCKET` wins, otherwise `$XDG_RUNTIME_DIR/.ydotool_socket`,
 * and if `XDG_RUNTIME_DIR` is unset fall back to ydotool's compiled-in
 * `/tmp/.ydotool_socket`. Pure — resolution only, no filesystem touch.
 */
export function resolveYdotoolSocket(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['YDOTOOL_SOCKET'];
  if (explicit && explicit.trim()) return explicit;
  const runtimeDir = env['XDG_RUNTIME_DIR'];
  if (runtimeDir && runtimeDir.trim()) return join(runtimeDir, '.ydotool_socket');
  return '/tmp/.ydotool_socket';
}

/**
 * Is the ydotoold daemon reachable? `ydotool` is a thin client: the socket
 * file existing means ydotoold is listening on it. This is an existence check
 * ONLY — it synthesizes no input (no mouse move, no keypress). `access` is
 * injectable so the probe is unit-testable without a live daemon.
 */
export async function isYdotooldRunning(
  socketPath: string,
  access: (p: string) => Promise<void> = (p) => fs.access(p),
): Promise<boolean> {
  try {
    await access(socketPath);
    return true;
  } catch {
    return false;
  }
}

export interface PlatformCheck {
  platform: Platform;
  displayServer: DisplayServer;
  screenshot: { available: boolean; tool: string };
  mouse: { available: boolean; tool: string };
  keyboard: { available: boolean; tool: string };
  /**
   * Input-synthesis daemon reachability. Wayland only: `ydotool` needs the
   * `ydotoold` daemon running or every input call hangs until timeout.
   * `undefined` off Wayland, or when the `ydotool` binary itself is missing
   * (the mouse/keyboard `fail` already covers that — no double-report).
   */
  daemon?: { name: string; socket: string; running: boolean };
  claudeCli: boolean;
  missingDeps: string[];
  installHint: string;
}

export async function checkPlatform(): Promise<PlatformCheck> {
  const platform = getPlatform();
  const displayServer = getDisplayServer();
  const missing: string[] = [];

  let screenshotTool = '';
  let screenshotAvail = false;
  let mouseTool = '';
  let mouseAvail = false;
  let keyboardTool = '';
  let keyboardAvail = false;
  let daemon: PlatformCheck['daemon'];

  if (platform === 'darwin') {
    screenshotTool = 'screencapture';
    screenshotAvail = true; // built-in
    mouseTool = 'cliclick';
    mouseAvail = await commandExists('cliclick');
    keyboardTool = 'cliclick';
    keyboardAvail = mouseAvail;
    if (!mouseAvail) missing.push('cliclick');
  } else if (platform === 'linux') {
    if (displayServer === 'wayland') {
      screenshotTool = 'grim';
      screenshotAvail = await commandExists('grim');
      if (!screenshotAvail) missing.push('grim');
      mouseTool = 'ydotool';
      mouseAvail = await commandExists('ydotool');
      keyboardTool = 'ydotool';
      keyboardAvail = mouseAvail;
      if (!mouseAvail) {
        missing.push('ydotool');
      } else {
        // The binary can be on PATH while ydotoold isn't listening — in which
        // case every input call hangs to timeout. Probe the daemon socket
        // (existence only) so doctor can warn before that happens.
        const socket = resolveYdotoolSocket();
        daemon = { name: 'ydotoold', socket, running: await isYdotooldRunning(socket) };
      }
    } else {
      screenshotTool = 'scrot';
      screenshotAvail = await commandExists('scrot');
      if (!screenshotAvail) missing.push('scrot');
      mouseTool = 'xdotool';
      mouseAvail = await commandExists('xdotool');
      keyboardTool = 'xdotool';
      keyboardAvail = mouseAvail;
      if (!mouseAvail) missing.push('xdotool');
    }
  } else if (platform === 'win32') {
    screenshotTool = 'powershell';
    screenshotAvail = true; // PowerShell built-in
    mouseTool = 'powershell';
    mouseAvail = true;
    keyboardTool = 'powershell';
    keyboardAvail = true;
  }

  const claudeCli = await commandExists('claude');

  let installHint = '';
  if (missing.length > 0) {
    if (platform === 'darwin') {
      installHint = `brew install ${missing.join(' ')}`;
    } else if (platform === 'linux') {
      installHint = `sudo apt install ${missing.join(' ')}`;
    }
  }

  return {
    platform,
    displayServer,
    screenshot: { available: screenshotAvail, tool: screenshotTool },
    mouse: { available: mouseAvail, tool: mouseTool },
    keyboard: { available: keyboardAvail, tool: keyboardTool },
    ...(daemon ? { daemon } : {}),
    claudeCli,
    missingDeps: missing,
    installHint,
  };
}
