import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { takeScreenshot } from './platform/screenshot.js';

const TOOLS = [
  {
    name: 'screenshot',
    description: 'Capture the current screen. Returns a JPEG image. Use this when you need to visually verify what is on screen. For all other computer control, use the built-in bash tool with PowerShell commands.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
];

export function createMCPServer(): Server {
  const server = new Server(
    { name: 'askalf-computer', version: '0.2.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === 'screenshot') {
      const ss = await takeScreenshot();
      return {
        content: [
          { type: 'image', data: ss.data, mimeType: ss.mediaType },
        ],
      };
    }
    return { content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }] };
  });

  return server;
}

export async function startStdioServer(): Promise<void> {
  const server = createMCPServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Entry-point check that survives spaces in the install path: compare
// resolved filesystem paths, not URL strings. import.meta.url percent-
// encodes spaces (%20) while argv[1] has them literal, so the old
// endsWith() comparison was false under any path containing a space —
// the spawned server exited silently and CLI mode lost its screenshot
// tool with no visible error.
const isMain = (() => {
  if (!process.argv[1]) return false;
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  try {
    return norm(resolve(process.argv[1])) === norm(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  startStdioServer().catch(console.error);
}
