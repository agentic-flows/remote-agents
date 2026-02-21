import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the MCP SDK before importing MCPManager
const mockConnect = vi.fn();
const mockListTools = vi.fn();
const mockCallTool = vi.fn();
const mockClose = vi.fn();

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  return {
    Client: vi.fn().mockImplementation(function () {
      return {
        connect: mockConnect,
        listTools: mockListTools,
        callTool: mockCallTool,
        close: mockClose,
      };
    }),
  };
});

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: vi.fn().mockImplementation(function () { return {}; }),
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn().mockImplementation(function () { return {}; }),
}));

import { MCPManager } from './mcp-manager';

/**
 * Creates a mock DurableObjectStorage with in-memory SQLite-like behavior.
 * Stores rows in a plain Map keyed by table name.
 */
function createMockStorage() {
  const rows: Map<string, Record<string, unknown>[]> = new Map();

  // Simulate SqlStorageCursor — must be iterable for Array.from()
  const execFn = vi.fn((...args: unknown[]) => {
    const q = (args[0] as string).trim().toUpperCase();
    const bindings = args.slice(1);
    let result: Record<string, unknown>[] = [];

    if (q.startsWith('CREATE TABLE')) {
      rows.set('mcp_servers', rows.get('mcp_servers') ?? []);
    } else if (q.startsWith('INSERT OR REPLACE')) {
      const table = rows.get('mcp_servers') ?? [];
      const existing = table.findIndex((r) => r.id === bindings[0]);
      const row = {
        id: bindings[0],
        name: bindings[1],
        server_url: bindings[2],
        server_options: bindings[3] ?? null,
      };
      if (existing >= 0) {
        table[existing] = row;
      } else {
        table.push(row);
      }
      rows.set('mcp_servers', table);
    } else if (q.startsWith('SELECT')) {
      result = [...(rows.get('mcp_servers') ?? [])];
    } else if (q.startsWith('DELETE')) {
      const table = rows.get('mcp_servers') ?? [];
      rows.set('mcp_servers', table.filter((r) => r.id !== bindings[0]));
    }

    // Return an iterable that Array.from() can consume
    return result[Symbol.iterator]();
  });

  return {
    sql: { exec: execFn },
    _rows: rows,
  } as unknown as DurableObjectStorage;
}

/** Helper: set up mockListTools to return tools */
function mockToolsResponse(tools: Array<{ name: string; description?: string; inputSchema?: object }>) {
  mockListTools.mockResolvedValueOnce({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema ?? { type: 'object', properties: {}, required: [] },
    })),
  });
}

describe('MCPManager', () => {
  let storage: DurableObjectStorage;

  beforeEach(() => {
    vi.clearAllMocks();
    storage = createMockStorage();
  });

  describe('constructor', () => {
    it('creates the mcp_servers table on construction', () => {
      new MCPManager(storage);
      expect((storage.sql.exec as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
        expect.stringContaining('CREATE TABLE IF NOT EXISTS mcp_servers'),
      );
    });
  });

  describe('initialize', () => {
    it('completes immediately with no stored servers', async () => {
      const manager = new MCPManager(storage);
      await manager.initialize();

      expect(mockConnect).not.toHaveBeenCalled();
      expect(manager.listTools()).toEqual([]);
    });

    it('is idempotent — second call is a no-op', async () => {
      const manager = new MCPManager(storage);
      await manager.initialize();
      await manager.initialize();

      // SELECT only called during constructor + first initialize
      const selectCalls = (storage.sql.exec as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => (c[0] as string).trim().toUpperCase().startsWith('SELECT'),
      );
      // 1 from first initialize, 0 from second
      expect(selectCalls.length).toBe(1);
    });
  });

  describe('addServer', () => {
    it('persists server to storage and connects', async () => {
      mockToolsResponse([{ name: 'tool_a' }, { name: 'tool_b' }]);

      const manager = new MCPManager(storage);
      await manager.addServer('srv-1', 'Test Server', 'https://mcp.example.com/api');

      expect(manager.hasServer('srv-1')).toBe(true);
      expect(mockConnect).toHaveBeenCalledOnce();
      expect(manager.getToolNames()).toEqual(['tool_a', 'tool_b']);
    });

    it('uses SSEClientTransport for /sse endpoints', async () => {
      const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
      mockToolsResponse([]);

      const manager = new MCPManager(storage);
      await manager.addServer('srv-sse', 'SSE Server', 'https://mcp.example.com/sse');

      expect(SSEClientTransport).toHaveBeenCalled();
    });

    it('uses StreamableHTTPClientTransport for non-/sse endpoints', async () => {
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
      mockToolsResponse([]);

      const manager = new MCPManager(storage);
      await manager.addServer('srv-http', 'HTTP Server', 'https://mcp.example.com/api');

      expect(StreamableHTTPClientTransport).toHaveBeenCalled();
    });

    it('passes headers from options to transport', async () => {
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
      mockToolsResponse([]);

      const manager = new MCPManager(storage);
      await manager.addServer('srv-auth', 'Auth Server', 'https://mcp.example.com/api', {
        headers: { Authorization: 'Bearer tok123' },
      });

      expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(
        expect.any(URL),
        expect.objectContaining({
          requestInit: { headers: { Authorization: 'Bearer tok123' } },
        }),
      );
    });

    it('handles connection failure gracefully — no tools registered', async () => {
      mockConnect.mockRejectedValueOnce(new Error('Connection refused'));

      const manager = new MCPManager(storage);
      // Should not throw
      await manager.addServer('srv-fail', 'Bad Server', 'https://bad.example.com/api');

      expect(manager.getToolNames()).toEqual([]);
      // Server is still in storage (persisted before connect attempt)
      expect(manager.hasServer('srv-fail')).toBe(true);
    });
  });

  describe('removeServer', () => {
    it('disconnects client, removes tools, and deletes from storage', async () => {
      mockToolsResponse([{ name: 'tool_x' }]);

      const manager = new MCPManager(storage);
      await manager.addServer('srv-rm', 'Remove Me', 'https://mcp.example.com/api');
      expect(manager.hasTool('tool_x')).toBe(true);

      await manager.removeServer('srv-rm');

      expect(mockClose).toHaveBeenCalledOnce();
      expect(manager.hasTool('tool_x')).toBe(false);
      expect(manager.hasServer('srv-rm')).toBe(false);
    });

    it('handles close error gracefully', async () => {
      mockToolsResponse([]);
      mockClose.mockRejectedValueOnce(new Error('close error'));

      const manager = new MCPManager(storage);
      await manager.addServer('srv-x', 'X', 'https://mcp.example.com/api');

      // Should not throw
      await manager.removeServer('srv-x');
      expect(manager.hasServer('srv-x')).toBe(false);
    });

    it('is safe to call for non-existent server', async () => {
      const manager = new MCPManager(storage);
      // Should not throw
      await manager.removeServer('does-not-exist');
    });
  });

  describe('listTools / getToolDefinitions', () => {
    it('returns MCP tools with serverId attached', async () => {
      mockToolsResponse([
        { name: 'gmail_send', description: 'Send email', inputSchema: { type: 'object', properties: { to: { type: 'string' } } } },
      ]);

      const manager = new MCPManager(storage);
      await manager.addServer('composio', 'Composio', 'https://composio.dev/mcp');

      const tools = manager.listTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('gmail_send');
      expect(tools[0].serverId).toBe('composio');
    });

    it('getToolDefinitions returns OpenAI-compatible format with implementation', async () => {
      mockToolsResponse([{ name: 'search', description: 'Web search' }]);
      mockCallTool.mockResolvedValueOnce({ content: [{ type: 'text', text: 'result' }] });

      const manager = new MCPManager(storage);
      await manager.addServer('srv', 'S', 'https://mcp.example.com/api');

      const defs = manager.getToolDefinitions();
      expect(defs).toHaveLength(1);
      expect(defs[0].type).toBe('function');
      expect(defs[0].function.name).toBe('search');
      expect(defs[0].function.description).toBe('Web search');
      expect(typeof defs[0].implementation).toBe('function');

      // Calling the implementation routes through callTool
      await defs[0].implementation({ query: 'test' });
      expect(mockCallTool).toHaveBeenCalledWith({ name: 'search', arguments: { query: 'test' } });
    });
  });

  describe('callTool', () => {
    it('calls the correct MCP client and returns result', async () => {
      mockToolsResponse([{ name: 'my_tool' }]);
      mockCallTool.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'hello' }],
      });

      const manager = new MCPManager(storage);
      await manager.addServer('srv', 'S', 'https://mcp.example.com/api');

      const result = await manager.callTool('my_tool', { input: 'test' });
      expect(result).toEqual({ content: [{ type: 'text', text: 'hello' }] });
    });

    it('throws when tool not found', async () => {
      const manager = new MCPManager(storage);
      await expect(manager.callTool('nonexistent', {})).rejects.toThrow('Tool nonexistent not found');
    });

    it('throws on error result with extracted text', async () => {
      mockToolsResponse([{ name: 'err_tool' }]);
      mockCallTool.mockResolvedValueOnce({
        isError: true,
        content: [{ type: 'text', text: 'Something went wrong' }],
      });

      const manager = new MCPManager(storage);
      await manager.addServer('srv', 'S', 'https://mcp.example.com/api');

      await expect(manager.callTool('err_tool', {})).rejects.toThrow(
        'Tool execution failed: Something went wrong',
      );
    });

    it('throws "Unknown error" when error result has no text content', async () => {
      mockToolsResponse([{ name: 'err_tool2' }]);
      mockCallTool.mockResolvedValueOnce({
        isError: true,
        content: 'not an array',
      });

      const manager = new MCPManager(storage);
      await manager.addServer('srv', 'S', 'https://mcp.example.com/api');

      await expect(manager.callTool('err_tool2', {})).rejects.toThrow(
        'Tool execution failed: Unknown error',
      );
    });
  });

  describe('shutdown', () => {
    it('closes all clients and clears state', async () => {
      mockToolsResponse([{ name: 't1' }]);
      mockToolsResponse([{ name: 't2' }]);

      const manager = new MCPManager(storage);
      await manager.addServer('a', 'A', 'https://a.example.com/api');
      await manager.addServer('b', 'B', 'https://b.example.com/api');

      expect(manager.getToolNames()).toHaveLength(2);

      await manager.shutdown();

      expect(mockClose).toHaveBeenCalledTimes(2);
      expect(manager.listTools()).toEqual([]);
      expect(manager.getToolNames()).toEqual([]);
    });

    it('handles close errors during shutdown gracefully', async () => {
      mockToolsResponse([{ name: 't1' }]);
      mockClose.mockRejectedValueOnce(new Error('shutdown error'));

      const manager = new MCPManager(storage);
      await manager.addServer('a', 'A', 'https://a.example.com/api');

      // Should not throw
      await manager.shutdown();
      expect(manager.listTools()).toEqual([]);
    });
  });

  describe('listServers / hasServer', () => {
    it('lists all persisted servers', async () => {
      mockToolsResponse([]);
      mockToolsResponse([]);

      const manager = new MCPManager(storage);
      await manager.addServer('s1', 'Server One', 'https://one.example.com/api');
      await manager.addServer('s2', 'Server Two', 'https://two.example.com/sse');

      const servers = manager.listServers();
      expect(servers).toHaveLength(2);
      expect(servers.map((s) => s.id)).toEqual(['s1', 's2']);
    });

    it('hasServer returns false for unknown server', () => {
      const manager = new MCPManager(storage);
      expect(manager.hasServer('nope')).toBe(false);
    });
  });
});
