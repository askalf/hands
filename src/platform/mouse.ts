import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getPlatform, getDisplayServer } from './index.js';

const execFileAsync = promisify(execFile);

// Every adapter call gets a hard timeout — a hung xdotool/cliclick/
// powershell otherwise stalls the agent's whole turn with no recovery.
const EXEC_TIMEOUT_MS = 15_000;
const EXEC_OPTS = { timeout: EXEC_TIMEOUT_MS };

export type ClickButton = 'left' | 'right' | 'middle';
export type ScrollDirection = 'up' | 'down' | 'left' | 'right';
/** Modifier key held during a click/scroll (the computer-use `text` param). */
export type ModifierKey = 'shift' | 'ctrl' | 'alt' | 'super';

const MOD_XDOTOOL: Record<ModifierKey, string> = { shift: 'shift', ctrl: 'ctrl', alt: 'alt', super: 'super' };
const MOD_CLICLICK: Record<ModifierKey, string> = { shift: 'shift', ctrl: 'ctrl', alt: 'alt', super: 'cmd' };
const MOD_VK: Record<ModifierKey, string> = { shift: '0x10', ctrl: '0x11', alt: '0x12', super: '0x5B' };

// Shared user32 interop block for Windows mouse scripts.
const WIN_MOUSE_TYPE = `
  Add-Type @"
    using System;
    using System.Runtime.InteropServices;
    public class MouseOps {
      [DllImport("user32.dll")] public static extern void SetCursorPos(int x, int y);
      [DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);
      [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    }
"@`;

function winModWrap(modifier: ModifierKey | undefined, body: string): string {
  if (!modifier) return body;
  const vk = MOD_VK[modifier];
  return [
    `[MouseOps]::keybd_event(${vk}, 0, 0, [UIntPtr]::Zero)`,
    'Start-Sleep -Milliseconds 30',
    body,
    'Start-Sleep -Milliseconds 30',
    `[MouseOps]::keybd_event(${vk}, 0, 0x0002, [UIntPtr]::Zero)`,
  ].join('\n');
}

async function runWinMouseScript(body: string): Promise<void> {
  const script = `${WIN_MOUSE_TYPE}\n${body}`;
  await execFileAsync('powershell', ['-NoProfile', '-Command', script], EXEC_OPTS);
}

export async function mouseMove(x: number, y: number): Promise<void> {
  const platform = getPlatform();

  if (platform === 'darwin') {
    await execFileAsync('cliclick', [`m:${x},${y}`], EXEC_OPTS);
  } else if (platform === 'linux') {
    const ds = getDisplayServer();
    if (ds === 'wayland') {
      await execFileAsync('ydotool', ['mousemove', '--absolute', '-x', String(x), '-y', String(y)], EXEC_OPTS);
    } else {
      await execFileAsync('xdotool', ['mousemove', String(x), String(y)], EXEC_OPTS);
    }
  } else if (platform === 'win32') {
    await runWinMouseScript(`[MouseOps]::SetCursorPos(${x}, ${y})`);
  }
}

export async function mouseClick(x: number, y: number, button: ClickButton = 'left', modifier?: ModifierKey): Promise<void> {
  const platform = getPlatform();

  if (platform === 'darwin') {
    const clickMap: Record<ClickButton, string> = { left: 'c', right: 'rc', middle: 'mc' };
    const args = modifier
      ? [`kd:${MOD_CLICLICK[modifier]}`, `${clickMap[button]}:${x},${y}`, `ku:${MOD_CLICLICK[modifier]}`]
      : [`${clickMap[button]}:${x},${y}`];
    await execFileAsync('cliclick', args, EXEC_OPTS);
  } else if (platform === 'linux') {
    const ds = getDisplayServer();
    if (ds === 'wayland') {
      // ydotool has no portable modifier-hold; modifier is best-effort ignored here.
      const btnMap: Record<ClickButton, string> = { left: '0xC0', right: '0xC1', middle: '0xC2' };
      await execFileAsync('ydotool', ['mousemove', '--absolute', '-x', String(x), '-y', String(y)], EXEC_OPTS);
      await execFileAsync('ydotool', ['click', btnMap[button]!], EXEC_OPTS);
    } else {
      const btnMap: Record<ClickButton, string> = { left: '1', right: '3', middle: '2' };
      const args = modifier
        ? ['keydown', MOD_XDOTOOL[modifier], 'mousemove', String(x), String(y), 'click', btnMap[button]!, 'keyup', MOD_XDOTOOL[modifier]]
        : ['mousemove', String(x), String(y), 'click', btnMap[button]!];
      await execFileAsync('xdotool', args, EXEC_OPTS);
    }
  } else if (platform === 'win32') {
    const events: Record<ClickButton, string> = {
      left: '[MouseOps]::mouse_event(0x02, 0, 0, 0, 0); [MouseOps]::mouse_event(0x04, 0, 0, 0, 0)',
      right: '[MouseOps]::mouse_event(0x08, 0, 0, 0, 0); [MouseOps]::mouse_event(0x10, 0, 0, 0, 0)',
      middle: '[MouseOps]::mouse_event(0x20, 0, 0, 0, 0); [MouseOps]::mouse_event(0x40, 0, 0, 0, 0)',
    };
    const body = [
      `[MouseOps]::SetCursorPos(${x}, ${y})`,
      'Start-Sleep -Milliseconds 50',
      winModWrap(modifier, events[button]),
    ].join('\n');
    await runWinMouseScript(body);
  }
}

export async function mouseDoubleClick(x: number, y: number): Promise<void> {
  await mouseMultiClick(x, y, 2);
}

export async function mouseTripleClick(x: number, y: number): Promise<void> {
  await mouseMultiClick(x, y, 3);
}

async function mouseMultiClick(x: number, y: number, count: 2 | 3): Promise<void> {
  const platform = getPlatform();

  if (platform === 'darwin') {
    // cliclick has native double/triple click ops
    await execFileAsync('cliclick', [`${count === 2 ? 'dc' : 'tc'}:${x},${y}`], EXEC_OPTS);
  } else if (platform === 'linux') {
    const ds = getDisplayServer();
    if (ds === 'wayland') {
      await execFileAsync('ydotool', ['mousemove', '--absolute', '-x', String(x), '-y', String(y)], EXEC_OPTS);
      await execFileAsync('ydotool', ['click', ...Array(count).fill('0xC0')], EXEC_OPTS);
    } else {
      await execFileAsync('xdotool', ['mousemove', String(x), String(y), 'click', '--repeat', String(count), '--delay', '50', '1'], EXEC_OPTS);
    }
  } else if (platform === 'win32') {
    // One script so the clicks land within the OS double-click interval
    const click = '[MouseOps]::mouse_event(0x02, 0, 0, 0, 0); [MouseOps]::mouse_event(0x04, 0, 0, 0, 0)';
    const body = [
      `[MouseOps]::SetCursorPos(${x}, ${y})`,
      'Start-Sleep -Milliseconds 50',
      ...Array(count).fill(null).flatMap((_, i) => (i === 0 ? [click] : ['Start-Sleep -Milliseconds 50', click])),
    ].join('\n');
    await runWinMouseScript(body);
  }
}

/** Press or release the left button without the paired action — for fine-grained drag control. */
export async function mouseButtonEvent(x: number, y: number, event: 'down' | 'up'): Promise<void> {
  const platform = getPlatform();

  if (platform === 'darwin') {
    await execFileAsync('cliclick', [`${event === 'down' ? 'dd' : 'du'}:${x},${y}`], EXEC_OPTS);
  } else if (platform === 'linux') {
    const ds = getDisplayServer();
    if (ds === 'wayland') {
      // ydotool click flags: 0x40 = press, 0x80 = release (low nibble = button 0 = left)
      await execFileAsync('ydotool', ['mousemove', '--absolute', '-x', String(x), '-y', String(y)], EXEC_OPTS);
      await execFileAsync('ydotool', ['click', event === 'down' ? '0x40' : '0x80'], EXEC_OPTS);
    } else {
      await execFileAsync('xdotool', ['mousemove', String(x), String(y), event === 'down' ? 'mousedown' : 'mouseup', '1'], EXEC_OPTS);
    }
  } else if (platform === 'win32') {
    const body = [
      `[MouseOps]::SetCursorPos(${x}, ${y})`,
      'Start-Sleep -Milliseconds 30',
      event === 'down' ? '[MouseOps]::mouse_event(0x02, 0, 0, 0, 0)' : '[MouseOps]::mouse_event(0x04, 0, 0, 0, 0)',
    ].join('\n');
    await runWinMouseScript(body);
  }
}

/** Click at the start point, drag to the end point, release. */
export async function mouseDrag(startX: number, startY: number, endX: number, endY: number): Promise<void> {
  const platform = getPlatform();

  if (platform === 'darwin') {
    // cliclick drag ops in one invocation: drag-down, drag-move, drag-up
    await execFileAsync('cliclick', [`dd:${startX},${startY}`, `dm:${endX},${endY}`, `du:${endX},${endY}`], EXEC_OPTS);
  } else if (platform === 'linux') {
    const ds = getDisplayServer();
    if (ds === 'wayland') {
      await execFileAsync('ydotool', ['mousemove', '--absolute', '-x', String(startX), '-y', String(startY)], EXEC_OPTS);
      await execFileAsync('ydotool', ['click', '0x40'], EXEC_OPTS);
      await execFileAsync('ydotool', ['mousemove', '--absolute', '-x', String(endX), '-y', String(endY)], EXEC_OPTS);
      await execFileAsync('ydotool', ['click', '0x80'], EXEC_OPTS);
    } else {
      await execFileAsync('xdotool', [
        'mousemove', String(startX), String(startY),
        'mousedown', '1',
        'sleep', '0.1',
        'mousemove', String(endX), String(endY),
        'sleep', '0.1',
        'mouseup', '1',
      ], EXEC_OPTS);
    }
  } else if (platform === 'win32') {
    const body = [
      `[MouseOps]::SetCursorPos(${startX}, ${startY})`,
      'Start-Sleep -Milliseconds 50',
      '[MouseOps]::mouse_event(0x02, 0, 0, 0, 0)',
      'Start-Sleep -Milliseconds 100',
      `[MouseOps]::SetCursorPos(${endX}, ${endY})`,
      'Start-Sleep -Milliseconds 100',
      '[MouseOps]::mouse_event(0x04, 0, 0, 0, 0)',
    ].join('\n');
    await runWinMouseScript(body);
  }
}

export async function mouseScroll(
  x: number,
  y: number,
  direction: ScrollDirection = 'down',
  clicks: number = 3,
  modifier?: ModifierKey,
): Promise<void> {
  const platform = getPlatform();
  const vertical = direction === 'up' || direction === 'down';

  if (platform === 'darwin') {
    // macOS has no CLI wheel synthesis (cliclick can't scroll; System
    // Events has no `scroll` verb — a previous version here used one and
    // errored on every call). Approximate with key presses at the cursor
    // position: Page Up/Down for vertical, arrow keys for horizontal.
    await execFileAsync('cliclick', [`m:${x},${y}`], EXEC_OPTS);
    const key = direction === 'up' ? 'page-up' : direction === 'down' ? 'page-down' : direction === 'left' ? 'arrow-left' : 'arrow-right';
    const presses = vertical ? Math.max(1, Math.ceil(clicks / 3)) : clicks;
    const ops = Array(presses).fill(`kp:${key}`);
    if (modifier) {
      await execFileAsync('cliclick', [`kd:${MOD_CLICLICK[modifier]}`, ...ops, `ku:${MOD_CLICLICK[modifier]}`], EXEC_OPTS);
    } else {
      await execFileAsync('cliclick', ops, EXEC_OPTS);
    }
  } else if (platform === 'linux') {
    const ds = getDisplayServer();
    if (ds === 'wayland') {
      await execFileAsync('ydotool', ['mousemove', '--absolute', '-x', String(x), '-y', String(y)], EXEC_OPTS);
      // Wheel mode: -y for vertical units, -x for horizontal
      const dx = direction === 'left' ? -1 : direction === 'right' ? 1 : 0;
      const dy = direction === 'up' ? 1 : direction === 'down' ? -1 : 0;
      for (let i = 0; i < clicks; i++) {
        await execFileAsync('ydotool', ['mousemove', '-w', '-x', String(dx), '-y', String(dy)], EXEC_OPTS);
      }
    } else {
      // X11 wheel buttons: 4 up, 5 down, 6 left, 7 right
      const btn = direction === 'up' ? '4' : direction === 'down' ? '5' : direction === 'left' ? '6' : '7';
      const args = ['mousemove', String(x), String(y), 'click', '--repeat', String(clicks), btn];
      if (modifier) {
        await execFileAsync('xdotool', ['keydown', MOD_XDOTOOL[modifier], ...args, 'keyup', MOD_XDOTOOL[modifier]], EXEC_OPTS);
      } else {
        await execFileAsync('xdotool', args, EXEC_OPTS);
      }
    }
  } else if (platform === 'win32') {
    // 0x0800 = MOUSEEVENTF_WHEEL (vertical), 0x01000 = MOUSEEVENTF_HWHEEL
    const flag = vertical ? '0x0800' : '0x01000';
    const sign = direction === 'up' || direction === 'right' ? 1 : -1;
    const delta = sign * 120 * clicks;
    const body = [
      `[MouseOps]::SetCursorPos(${x}, ${y})`,
      winModWrap(modifier, `[MouseOps]::mouse_event(${flag}, 0, 0, ${delta}, 0)`),
    ].join('\n');
    await runWinMouseScript(body);
  }
}
