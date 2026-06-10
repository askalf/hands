import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getPlatform, getDisplayServer } from './index.js';

const execFileAsync = promisify(execFile);

// Hard timeout on every adapter call — a hung tool otherwise stalls the
// agent's whole turn. Generous enough for hold_key's max duration.
const EXEC_OPTS = { timeout: 15_000 };

export async function keyboardType(text: string): Promise<void> {
  const platform = getPlatform();

  if (platform === 'darwin') {
    // cliclick t: for typing text
    await execFileAsync('cliclick', [`t:${text}`], EXEC_OPTS);
  } else if (platform === 'linux') {
    const ds = getDisplayServer();
    if (ds === 'wayland') {
      await execFileAsync('ydotool', ['type', '--', text], EXEC_OPTS);
    } else {
      await execFileAsync('xdotool', ['type', '--clearmodifiers', '--', text], EXEC_OPTS);
    }
  } else if (platform === 'win32') {
    // Escape special SendKeys characters
    const escaped = text.replace(/([+^%~(){}[\]])/g, '{$1}');
    const script = `
      Add-Type -AssemblyName System.Windows.Forms
      [System.Windows.Forms.SendKeys]::SendWait('${escaped.replace(/'/g, "''")}')
    `;
    await execFileAsync('powershell', ['-NoProfile', '-Command', script], EXEC_OPTS);
  }
}

// Key combo mapping: Claude sends keys like "ctrl+c", "Return", "space", etc.
const KEY_MAP_XDOTOOL: Record<string, string> = {
  return: 'Return', enter: 'Return',
  tab: 'Tab', escape: 'Escape', space: 'space',
  backspace: 'BackSpace', delete: 'Delete',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  home: 'Home', end: 'End', pageup: 'Prior', pagedown: 'Next',
  f1: 'F1', f2: 'F2', f3: 'F3', f4: 'F4', f5: 'F5', f6: 'F6',
  f7: 'F7', f8: 'F8', f9: 'F9', f10: 'F10', f11: 'F11', f12: 'F12',
  ctrl: 'ctrl', alt: 'alt', shift: 'shift', super: 'super', meta: 'super',
  cmd: 'super', command: 'super', win: 'super',
};

const KEY_MAP_CLICLICK: Record<string, string> = {
  return: 'return', enter: 'return',
  tab: 'tab', escape: 'escape', space: 'space',
  backspace: 'delete', delete: 'fwd-delete',
  up: 'arrow-up', down: 'arrow-down', left: 'arrow-left', right: 'arrow-right',
  home: 'home', end: 'end', pageup: 'page-up', pagedown: 'page-down',
  f1: 'f1', f2: 'f2', f3: 'f3', f4: 'f4', f5: 'f5', f6: 'f6',
  f7: 'f7', f8: 'f8', f9: 'f9', f10: 'f10', f11: 'f11', f12: 'f12',
};

const KEY_MAP_WIN: Record<string, string> = {
  return: '{ENTER}', enter: '{ENTER}',
  tab: '{TAB}', escape: '{ESC}', space: ' ',
  backspace: '{BACKSPACE}', delete: '{DELETE}',
  up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}',
  home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}',
  f1: '{F1}', f2: '{F2}', f3: '{F3}', f4: '{F4}', f5: '{F5}', f6: '{F6}',
  f7: '{F7}', f8: '{F8}', f9: '{F9}', f10: '{F10}', f11: '{F11}', f12: '{F12}',
  ctrl: '^', alt: '%', shift: '+',
};

export async function keyboardKey(combo: string): Promise<void> {
  const platform = getPlatform();
  const parts = combo.toLowerCase().split('+').map(p => p.trim());

  if (platform === 'darwin') {
    await keyPressMac(parts);
  } else if (platform === 'linux') {
    const ds = getDisplayServer();
    if (ds === 'wayland') {
      await keyPressYdotool(parts);
    } else {
      await keyPressXdotool(parts);
    }
  } else if (platform === 'win32') {
    await keyPressWindows(parts);
  }
}

async function keyPressMac(parts: string[]): Promise<void> {
  // Build cliclick key press command
  const modifiers: string[] = [];
  let key = '';

  for (const part of parts) {
    if (part === 'ctrl' || part === 'control') modifiers.push('ctrl');
    else if (part === 'alt' || part === 'option') modifiers.push('alt');
    else if (part === 'shift') modifiers.push('shift');
    else if (part === 'cmd' || part === 'command' || part === 'meta' || part === 'super') modifiers.push('cmd');
    else key = KEY_MAP_CLICLICK[part] ?? part;
  }

  if (key) {
    const modStr = modifiers.length > 0 ? modifiers.join(',') + ' ' : '';
    // cliclick kp:modifier key
    await execFileAsync('cliclick', [`kp:${modStr}${key}`], EXEC_OPTS);
  }
}

async function keyPressXdotool(parts: string[]): Promise<void> {
  const mapped = parts.map(p => KEY_MAP_XDOTOOL[p] ?? p);
  await execFileAsync('xdotool', ['key', mapped.join('+')], EXEC_OPTS);
}

async function keyPressYdotool(parts: string[]): Promise<void> {
  // ydotool uses kernel keycodes — simplified approach using xdotool key names
  // For full ydotool support, would need keycode mapping
  const mapped = parts.map(p => KEY_MAP_XDOTOOL[p] ?? p);
  await execFileAsync('ydotool', ['key', mapped.join('+')], EXEC_OPTS);
}

// VK codes for keys the hold_key action commonly targets on Windows.
const VK_WIN: Record<string, number> = {
  ctrl: 0x11, control: 0x11, alt: 0x12, shift: 0x10,
  super: 0x5B, meta: 0x5B, win: 0x5B, cmd: 0x5B, command: 0x5B,
  return: 0x0D, enter: 0x0D, tab: 0x09, escape: 0x1B, space: 0x20,
  backspace: 0x08, delete: 0x2E,
  left: 0x25, up: 0x26, right: 0x27, down: 0x28,
  home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
};

// macOS virtual key codes for named keys (System Events `key code N`).
const KEYCODE_MAC: Record<string, number> = {
  return: 36, enter: 36, tab: 48, space: 49, backspace: 51, delete: 117,
  escape: 53, left: 123, right: 124, down: 125, up: 126,
  home: 115, end: 119, pageup: 116, pagedown: 121,
};

/**
 * Hold a key down for `durationSec` seconds, then release. This is the
 * computer-use `hold_key` action — distinct from `key` (press+release)
 * and from the modifier param on clicks (hold while doing something
 * else). Duration is clamped to [0.1, 10] so a confused model can't
 * wedge the keyboard.
 */
export async function keyboardHoldKey(key: string, durationSec: number): Promise<void> {
  const platform = getPlatform();
  const duration = Math.min(10, Math.max(0.1, durationSec));
  const name = key.toLowerCase().trim();

  if (platform === 'darwin') {
    const mods = ['ctrl', 'control', 'alt', 'option', 'shift', 'cmd', 'command', 'meta', 'super'];
    if (mods.includes(name)) {
      const mod = name === 'control' ? 'ctrl' : name === 'option' ? 'alt' : ['cmd', 'command', 'meta', 'super'].includes(name) ? 'cmd' : name;
      await execFileAsync('cliclick', [`kd:${mod}`, `w:${Math.round(duration * 1000)}`, `ku:${mod}`], EXEC_OPTS);
    } else {
      const target = KEYCODE_MAC[name] !== undefined ? `key code ${KEYCODE_MAC[name]}` : `"${name.slice(0, 1)}"`;
      const script = `tell application "System Events"\nkey down ${target}\ndelay ${duration}\nkey up ${target}\nend tell`;
      await execFileAsync('osascript', ['-e', script], EXEC_OPTS);
    }
  } else if (platform === 'linux') {
    const ds = getDisplayServer();
    const mapped = KEY_MAP_XDOTOOL[name] ?? name;
    if (ds === 'wayland') {
      // Best-effort, matching keyPressYdotool's name-based approach
      await execFileAsync('ydotool', ['key', `${mapped}:1`], EXEC_OPTS);
      await new Promise((r) => setTimeout(r, duration * 1000));
      await execFileAsync('ydotool', ['key', `${mapped}:0`], EXEC_OPTS);
    } else {
      await execFileAsync('xdotool', ['keydown', mapped, 'sleep', String(duration), 'keyup', mapped], EXEC_OPTS);
    }
  } else if (platform === 'win32') {
    const known = VK_WIN[name];
    const vkExpr = known !== undefined
      ? `0x${known.toString(16)}`
      : `([KbdOps]::VkKeyScanA([char]'${name.slice(0, 1).replace(/'/g, "''")}') -band 0xFF)`;
    const script = `
      Add-Type @"
        using System;
        using System.Runtime.InteropServices;
        public class KbdOps {
          [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
          [DllImport("user32.dll")] public static extern short VkKeyScanA(char ch);
        }
"@
      $vk = ${vkExpr}
      [KbdOps]::keybd_event($vk, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds ${Math.round(duration * 1000)}
      [KbdOps]::keybd_event($vk, 0, 0x0002, [UIntPtr]::Zero)
    `;
    await execFileAsync('powershell', ['-NoProfile', '-Command', script], EXEC_OPTS);
  }
}

async function keyPressWindows(parts: string[]): Promise<void> {
  const hasWinKey = parts.some(p => ['super', 'meta', 'win', 'cmd', 'command'].includes(p));

  if (hasWinKey) {
    // SendKeys doesn't support Windows key — use WScript.Shell SendKeys via COM
    // or use C# interop with keybd_event
    const otherKeys = parts.filter(p => !['super', 'meta', 'win', 'cmd', 'command'].includes(p));
    const script = `
      Add-Type @"
        using System;
        using System.Runtime.InteropServices;
        public class WinKey {
          [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
          public const byte VK_LWIN = 0x5B;
          public const uint KEYEVENTF_KEYUP = 0x0002;
        }
"@
      [WinKey]::keybd_event([WinKey]::VK_LWIN, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 100
      ${otherKeys.length > 0 ? `
      Add-Type -AssemblyName System.Windows.Forms
      [System.Windows.Forms.SendKeys]::SendWait('${otherKeys.map(k => KEY_MAP_WIN[k] ?? k).join('').replace(/'/g, "''")}')
      ` : ''}
      [WinKey]::keybd_event([WinKey]::VK_LWIN, 0, [WinKey]::KEYEVENTF_KEYUP, [UIntPtr]::Zero)
    `;
    await execFileAsync('powershell', ['-NoProfile', '-Command', script], EXEC_OPTS);
    return;
  }

  let sendKeys = '';
  let mainKey = '';

  for (const part of parts) {
    if (part === 'ctrl' || part === 'control') sendKeys += '^';
    else if (part === 'alt') sendKeys += '%';
    else if (part === 'shift') sendKeys += '+';
    else mainKey = KEY_MAP_WIN[part] ?? part;
  }

  sendKeys += mainKey.length === 1 ? mainKey : (KEY_MAP_WIN[parts[parts.length - 1]!] ?? `{${parts[parts.length - 1]!.toUpperCase()}}`);

  const script = `
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.SendKeys]::SendWait('${sendKeys.replace(/'/g, "''")}')
  `;
  await execFileAsync('powershell', ['-NoProfile', '-Command', script], EXEC_OPTS);
}
