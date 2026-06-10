import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getPlatform, getDisplayServer } from './index.js';

const execFileAsync = promisify(execFile);

export interface ScreenshotResult {
  data: string;
  mediaType: 'image/png' | 'image/jpeg';
}

export interface ScreenshotOptions {
  /**
   * Capture only this region, in REAL screen pixels: [x, y, width, height].
   * Region captures are returned at full resolution (no downscale) — this
   * backs the computer-use `zoom` action, whose whole point is legibility.
   */
  region?: [number, number, number, number];
}

const EXEC_TIMEOUT_MS = 15_000;

export async function takeScreenshot(opts: ScreenshotOptions = {}): Promise<ScreenshotResult> {
  const platform = getPlatform();
  const id = randomBytes(4).toString('hex');
  const tmpPath = join(tmpdir(), `askalf-ss-${id}.png`);
  const region = opts.region;

  try {
    if (platform === 'darwin') {
      const args = region
        ? ['-x', '-R', `${region[0]},${region[1]},${region[2]},${region[3]}`, tmpPath]
        : ['-x', tmpPath];
      await execFileAsync('screencapture', args, { timeout: EXEC_TIMEOUT_MS });
    } else if (platform === 'linux') {
      const ds = getDisplayServer();
      if (ds === 'wayland') {
        const args = region
          ? ['-g', `${region[0]},${region[1]} ${region[2]}x${region[3]}`, tmpPath]
          : [tmpPath];
        await execFileAsync('grim', args, { timeout: EXEC_TIMEOUT_MS });
      } else {
        const args = region
          ? ['-a', `${region[0]},${region[1]},${region[2]},${region[3]}`, tmpPath]
          : [tmpPath];
        await execFileAsync('scrot', args, { timeout: EXEC_TIMEOUT_MS });
      }
    } else if (platform === 'win32') {
      // Full-screen captures are resized to 1280px wide and JPEG-encoded to
      // stay under the API's 5MB limit; region captures stay full-res.
      const jpgPath = join(tmpdir(), `askalf-ss-${id}.jpg`);
      const scriptPath = join(tmpdir(), `askalf-cap-${id}.ps1`);
      const captureLines = region
        ? [
          `$bmp = New-Object Drawing.Bitmap ${region[2]},${region[3]}`,
          '$g = [Drawing.Graphics]::FromImage($bmp)',
          `$g.CopyFromScreen(${region[0]}, ${region[1]}, 0, 0, (New-Object Drawing.Size ${region[2]},${region[3]}))`,
          '$g.Dispose()',
          '$dst = $bmp',
        ]
        : [
          '$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
          '$bmp = New-Object Drawing.Bitmap $b.Width,$b.Height',
          '$g = [Drawing.Graphics]::FromImage($bmp)',
          '$g.CopyFromScreen($b.Location,[Drawing.Point]::Empty,$b.Size)',
          '$g.Dispose()',
          '$ratio = [Math]::Min(1.0, 1280.0 / $b.Width)',
          '$nw = [int]($b.Width * $ratio); $nh = [int]($b.Height * $ratio)',
          '$dst = New-Object Drawing.Bitmap $bmp,$nw,$nh',
          '$bmp.Dispose()',
        ];
      const script = [
        '$ErrorActionPreference = "Stop"',
        'Add-Type -AssemblyName System.Drawing',
        '[void][System.Reflection.Assembly]::LoadWithPartialName("System.Windows.Forms")',
        ...captureLines,
        '$codec = [Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object MimeType -eq "image/jpeg"',
        '$ep = New-Object Drawing.Imaging.EncoderParameters 1',
        '$ep.Param[0] = New-Object Drawing.Imaging.EncoderParameter ([Drawing.Imaging.Encoder]::Quality, [long]80)',
        `$dst.Save("${jpgPath.replace(/\\/g, '\\\\')}", $codec, $ep)`,
        '$dst.Dispose()',
      ].join('\r\n');
      await writeFile(scriptPath, script, 'utf-8');
      try {
        await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { timeout: EXEC_TIMEOUT_MS });
        const buffer = await readFile(jpgPath);
        return { data: buffer.toString('base64'), mediaType: 'image/jpeg' };
      } finally {
        try { await unlink(scriptPath); } catch { /* ignore */ }
        try { await unlink(jpgPath); } catch { /* ignore */ }
      }
    }

    const buffer = await readFile(tmpPath);
    return { data: buffer.toString('base64'), mediaType: 'image/png' };
  } finally {
    try { await unlink(tmpPath); } catch { /* ignore */ }
  }
}
