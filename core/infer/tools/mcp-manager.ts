/**
 * MCP Manager - Manages MCP server connections with persistence
 *
 * @deprecated Prefer the Agents SDK built-in MCPClientManager (`this.mcp` on Agent subclasses).
 * TenantAgent and TenantChatAgent now use the SDK's MCPClientManager for MCP management.
 * This class is retained as a reusable primitive for contexts where the Agents SDK is
 * unavailable (e.g. standalone Workers without Durable Objects, or voice agents requiring
 * synchronous initialization where all tools must be ready before the first LLM inference).
 *
 * Unlike the Agents SDK's MCPClientManager, this implementation:
 * - Awaits all connections before returning (no race conditions)
 * - Uses explicit initialization that callers must await
 * - Stores server configs in SQLite for persistence across restarts
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createLogger } from "../inferutils/logger";
import type { ToolDefinition } from "./types";

const logger = createLogger("MCPManager");

/**
 * Row in the mcp_servers table
 */
export type MCPServerRow = {
  id: string;
  name: string;
  server_url: string;
  server_options: string | null;
};

/**
 * Options for MCP server connection
 */
export type MCPServerOptions = {
  headers?: Record<string, string>;
};

/**
 * MCP tool with server ID for routing
 */
export type MCPToolWithServer = Tool & { serverId: string };

export class MCPManager {
  private clients: Map<string, Client> = new Map();
  private tools: Map<string, MCPToolWithServer> = new Map();
  private initialized = false;
  private storage: DurableObjectStorage;

  constructor(storage: DurableObjectStorage) {
    this.storage = storage;
    this.ensureTable();
  }

  /**
   * Create the mcp_servers table if it doesn't exist
   */
  private ensureTable(): void {
    this.sqlExec(`
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        server_url TEXT NOT NULL,
        server_options TEXT
      )
    `);
  }

  /**
   * SQL helper - runs a query and returns results as array
   */
  private sqlExec<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: SqlStorageValue[]
  ): T[] {
    return Array.from(this.storage.sql.exec<T>(query, ...bindings));
  }

  /**
   * Get all servers from storage
   */
  private getServersFromStorage(): MCPServerRow[] {
    return this.sqlExec<MCPServerRow>(
      "SELECT id, name, server_url, server_options FROM mcp_servers",
    );
  }

  /**
   * Save a server to storage
   */
  private saveServerToStorage(server: MCPServerRow): void {
    this.sqlExec(
      `INSERT OR REPLACE INTO mcp_servers (id, name, server_url, server_options) VALUES (?, ?, ?, ?)`,
      server.id,
      server.name,
      server.server_url,
      server.server_options,
    );
  }

  /**
   * Remove a server from storage
   */
  private removeServerFromStorage(serverId: string): void {
    this.sqlExec("DELETE FROM mcp_servers WHERE id = ?", serverId);
  }

  /**
   * Initialize connections to all stored MCP servers.
   * This MUST be awaited before using tools.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const servers = this.getServersFromStorage();
    logger.info("Initializing MCP manager", { serverCount: servers.length });

    for (const server of servers) {
      await this.connectToServer(server);
    }

    this.initialized = true;
    logger.info("MCP manager initialized", {
      connectedServers: this.clients.size,
      totalTools: this.tools.size,
    });
  }

  /**
   * Connect to a single MCP server
   */
  private async connectToServer(server: MCPServerRow): Promise<void> {
    try {
      logger.info("Connecting to MCP server", {
        id: server.id,
        name: server.name,
        url: server.server_url,
      });

      const url = new URL(server.server_url);

      // Parse options if present
      const options: MCPServerOptions = server.server_options
        ? JSON.parse(server.server_options)
        : {};

      // SSE for endpoints ending in /sse, StreamableHTTP otherwise
      const isSSE = url.pathname.endsWith("/sse");
      const transport = isSSE
        ? new SSEClientTransport(url, { requestInit: { headers: options.headers } })
        : new StreamableHTTPClientTransport(url, { requestInit: { headers: options.headers } });

      const client = new Client(
        { name: "dream-agent", version: "1.0.0" },
        { capabilities: {} },
      );

      await client.connect(transport);
      this.clients.set(server.id, client);

      // Discover tools
      const toolsResult = await client.listTools();
      if (toolsResult?.tools) {
        for (const tool of toolsResult.tools) {
          const toolWithServer: MCPToolWithServer = {
            ...tool,
            serverId: server.id,
          };
          this.tools.set(tool.name, toolWithServer);
        }
      }

      const toolNames = toolsResult?.tools?.map((t) => t.name) ?? [];
      logger.info("Connected to MCP server", {
        id: server.id,
        name: server.name,
        toolCount: toolsResult?.tools?.length ?? 0,
        toolNames,
      });
    } catch (error) {
      logger.error("Failed to connect to MCP server", {
        id: server.id,
        name: server.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Register and connect to a new MCP server.
   * Persists to storage and immediately connects.
   */
  async addServer(
    id: string,
    name: string,
    serverUrl: string,
    options?: MCPServerOptions,
  ): Promise<void> {
    const server: MCPServerRow = {
      id,
      name,
      server_url: serverUrl,
      server_options: options ? JSON.stringify(options) : null,
    };

    this.saveServerToStorage(server);
    await this.connectToServer(server);
  }

  /**
   * Remove an MCP server - disconnects and removes from storage
   */
  async removeServer(serverId: string): Promise<void> {
    const client = this.clients.get(serverId);
    if (client) {
      try {
        await client.close();
      } catch (error) {
        logger.warn("Error closing MCP client", { serverId, error });
      }
      this.clients.delete(serverId);
    }

    // Remove tools from this server
    const toolEntries = Array.from(this.tools.entries());
    for (const [toolName, tool] of toolEntries) {
      if (tool.serverId === serverId) {
        this.tools.delete(toolName);
      }
    }

    this.removeServerFromStorage(serverId);
    logger.info("Removed MCP server", { serverId });
  }

  /**
   * List all registered servers
   */
  listServers(): MCPServerRow[] {
    return this.getServersFromStorage();
  }

  /**
   * Check if a server is registered
   */
  hasServer(serverId: string): boolean {
    const servers = this.getServersFromStorage();
    return servers.some((s) => s.id === serverId);
  }

  /**
   * Get all available tools from all connected servers
   */
  listTools(): MCPToolWithServer[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get tool definitions in our ToolDefinition format (OpenAI-compatible with implementation)
   */
  getToolDefinitions(): ToolDefinition[] {
    return this.listTools().map((tool) => this.toolToDefinition(tool));
  }

  /**
   * Convert an MCP tool to our ToolDefinition format
   */
  private toolToDefinition(tool: MCPToolWithServer): ToolDefinition {
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: (tool.inputSchema as Record<string, unknown>) || {
          type: "object",
          properties: {},
          required: [],
        },
      },
      implementation: async (args: Record<string, unknown>) => {
        return this.callTool(tool.name, args);
      },
    };
  }

  /**
   * Call a tool by name
   */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      throw new Error(`Tool ${toolName} not found`);
    }

    const client = this.clients.get(tool.serverId);
    if (!client) {
      throw new Error(`Client for server ${tool.serverId} not available`);
    }

    logger.info("Calling MCP tool", {
      toolName,
      serverId: tool.serverId,
      args: JSON.stringify(args).slice(0, 500),
    });

    const result = await client.callTool({
      name: toolName,
      arguments: args,
    });

    if (result.isError) {
      const errorText = Array.isArray(result.content)
        ? result.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text)
            .join("\n")
        : "Unknown error";
      throw new Error(`Tool execution failed: ${errorText}`);
    }

    logger.info("MCP tool result", {
      toolName,
      resultType: typeof result.content,
    });

    return result;
  }

  /**
   * Check if a tool is available
   */
  hasTool(toolName: string): boolean {
    return this.tools.has(toolName);
  }

  /**
   * Get available tool names
   */
  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Shutdown - close all connections
   */
  async shutdown(): Promise<void> {
    logger.info("Shutting down MCP manager");

    const clientEntries = Array.from(this.clients.entries());
    for (const [serverId, client] of clientEntries) {
      try {
        await client.close();
      } catch (error) {
        logger.warn("Error closing MCP client", { serverId, error });
      }
    }

    this.clients.clear();
    this.tools.clear();
    this.initialized = false;

    logger.info("MCP manager shutdown complete");
  }
}
