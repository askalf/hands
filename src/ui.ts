// Semantic UI targeting — `hands run --ui`.
//
// Most computer-use agents click by PIXEL: screenshot, reason about
// coordinates, click, screenshot again to check. It's slow, expensive, and
// brittle to any layout shift. hands can read the OS accessibility tree
// instead and click "the Save button" by NAME and ROLE — no screenshot, no
// coordinates. Same philosophy as its shell-first bias, applied to the GUI.
//
// Windows-first: the foreground window's UIAutomation tree, enumerated via a
// signed PowerShell host (no unsigned native code, no .ps1 file → no
// execution-policy or Smart-App-Control snag). macOS (AX) / Linux (AT-SPI)
// are not wired yet and report so. Pure parsing + matching here; the SDK
// tools live in sdk-mode.ts.

import { execFile } from 'node:child_process';

export interface UiElement {
  name: string;
  /** Control type, e.g. Button, Edit, MenuItem, CheckBox. */
  role: string;
  x: number;
  y: number;
  w: number;
  h: number;
  enabled: boolean;
}

// PowerShell that enumerates the FOREGROUND window's named, on-screen
// descendants. Capped and filtered so a heavy app can't return thousands of
// nodes. Emits a JSON array (always an array via @(...)).
const PS_ENUM = [
  'Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes',
  '$sig = \'[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();\'',
  '$u = Add-Type -MemberDefinition $sig -Name U -Namespace Hands -PassThru',
  '$h = $u::GetForegroundWindow()',
  '$win = [System.Windows.Automation.AutomationElement]::FromHandle($h)',
  'if ($win -eq $null) { "[]"; exit }',
  '$els = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)',
  '$out = @(); $i = 0',
  'foreach ($e in $els) {',
  '  if ($i -ge 60) { break }',
  '  $n = $e.Current.Name',
  '  if ([string]::IsNullOrWhiteSpace($n)) { continue }',
  '  $r = $e.Current.BoundingRectangle',
  '  if ($r.Width -le 0 -or $r.Height -le 0) { continue }',
  '  $out += [pscustomobject]@{ name = $n; role = ($e.Current.ControlType.ProgrammaticName -replace "ControlType\\.",""); x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height; enabled = $e.Current.IsEnabled }',
  '  $i++',
  '}',
  'ConvertTo-Json -Compress -InputObject @($out)',
].join('\n');

// ── pure ────────────────────────────────────────────────────────────

/** Parse the PowerShell JSON output, tolerating a single object or empty. Pure. */
export function parseUiElements(json: string): UiElement[] {
  const text = (json ?? '').trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const out: UiElement[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r['name'] !== 'string') continue;
    out.push({
      name: r['name'],
      role: typeof r['role'] === 'string' ? r['role'] : 'Unknown',
      x: Number(r['x']) || 0,
      y: Number(r['y']) || 0,
      w: Number(r['w']) || 0,
      h: Number(r['h']) || 0,
      enabled: r['enabled'] !== false,
    });
  }
  return out;
}

export interface ElementQuery {
  /** Case-insensitive substring of the element name. */
  name?: string | undefined;
  /** Case-insensitive substring of the control role (Button, Edit, …). */
  role?: string | undefined;
}

/**
 * Find elements matching a query, best first: exact name (case-insensitive)
 * before substring; an empty/zero-size or disabled element ranks last. Pure.
 */
export function findElements(elements: UiElement[], query: ElementQuery): UiElement[] {
  const name = query.name?.toLowerCase();
  const role = query.role?.toLowerCase();
  const scored = elements
    .filter((e) => (name ? e.name.toLowerCase().includes(name) : true) && (role ? e.role.toLowerCase().includes(role) : true))
    .map((e) => {
      let score = 0;
      if (name && e.name.toLowerCase() === name) score += 100; // exact name wins
      if (!e.enabled) score -= 50;
      if (e.w <= 0 || e.h <= 0) score -= 25;
      return { e, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored.map((s) => s.e);
}

/** Center point of an element, for clicking. Pure. */
export function elementCenter(e: UiElement): { x: number; y: number } {
  return { x: Math.round(e.x + e.w / 2), y: Math.round(e.y + e.h / 2) };
}

/** One-line render of an element for the agent's ui_tree result. Pure. */
export function describeElement(e: UiElement): string {
  return `${e.role} "${e.name}"${e.enabled ? '' : ' (disabled)'} @ (${e.x}, ${e.y}) ${e.w}x${e.h}`;
}

// ── SDK tool + prompt builders ──────────────────────────────────────

/** System-prompt nudge toward semantic targeting over pixel clicking. Pure. */
export function buildUiInstruction(): string {
  return [
    'UI TARGETING: you can read the active window\'s controls from the OS accessibility tree.',
    'Use `ui_tree` to list controls by name and role, and `click_element` to click one BY NAME.',
    'PREFER these over screenshot + pixel-coordinate clicking whenever you can identify a control by its visible name — they are faster and far more reliable across layout changes.',
    'Use a screenshot only to see something the tree does not expose.',
  ].join(' ');
}

/** The `ui_tree` tool declaration (shape only). Pure. */
export function buildUiTreeTool(): Record<string, unknown> {
  return {
    name: 'ui_tree',
    description: 'List the named, clickable controls of the ACTIVE window from the OS accessibility tree (name, role, position, enabled). Use this INSTEAD OF a screenshot when you need to find or target a control by its visible name — it is faster and more reliable than reasoning about pixels. Then use click_element to click one. Windows only for now.',
    input_schema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Optional case-insensitive substring to narrow the list by control name.' },
      },
      required: [],
    },
  };
}

/** The `click_element` tool declaration (shape only). Pure. */
export function buildClickElementTool(): Record<string, unknown> {
  return {
    name: 'click_element',
    description: 'Click a control in the ACTIVE window BY NAME (and optionally role), using the OS accessibility tree — no screenshot, no pixel coordinates. Pass `name` (the visible label, case-insensitive substring) and optionally `role` (Button, MenuItem, CheckBox, Edit, TabItem, …). Far more reliable than computer-tool coordinate clicking when the control has a name. Returns which element was clicked, or the available candidates if there is no unambiguous match. Windows only for now.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Visible name of the control to click (case-insensitive substring).' },
        role: { type: 'string', description: 'Optional control role to disambiguate (Button, MenuItem, …).' },
      },
      required: ['name'],
    },
  };
}

// ── enumeration (platform) ──────────────────────────────────────────

/**
 * Enumerate the foreground window's accessibility elements. Windows-only for
 * now; throws a clear message elsewhere. Rejects on host/timeout error.
 */
export function enumerateUiElements(): Promise<UiElement[]> {
  if (process.platform !== 'win32') {
    return Promise.reject(new Error('Semantic UI targeting is Windows-only for now (UIAutomation). macOS (AX) / Linux (AT-SPI) are not wired yet.'));
  }
  return new Promise((resolve, reject) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_ENUM],
      { timeout: 12_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err && !stdout) {
          reject(new Error(`UIAutomation enumeration failed: ${err.message}`));
          return;
        }
        resolve(parseUiElements(stdout));
      },
    );
  });
}
