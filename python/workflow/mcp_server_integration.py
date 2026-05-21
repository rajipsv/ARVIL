"""
MCP (Model Context Protocol) Server Integration for Log Analysis

This module provides integration with MCP servers to enable:
1. Reading logs from remote sources
2. Streaming log analysis
3. Real-time error detection
"""

import asyncio
import json
from typing import Dict, Any, Optional
from datetime import datetime


class MCPLogServer:
    """
    MCP Server implementation for log file analysis
    
    This server exposes tools and resources for analyzing log files
    through the Model Context Protocol.
    """
    
    def __init__(self, name: str = "log-analyzer-mcp"):
        self.name = name
        self.version = "0.1.0"
        self.capabilities = {
            "tools": True,
            "resources": True,
            "prompts": True
        }
        
    def get_server_info(self) -> Dict[str, Any]:
        """Get MCP server information"""
        return {
            "name": self.name,
            "version": self.version,
            "capabilities": self.capabilities,
            "description": "Log analysis server using LangChain and LangGraph"
        }
    
    async def list_tools(self) -> list[Dict[str, Any]]:
        """List available tools"""
        return [
            {
                "name": "analyze_log_file",
                "description": "Analyze a log file for errors and issues",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "file_path": {
                            "type": "string",
                            "description": "Path to the log file"
                        },
                        "error_types": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Types of errors to look for (ERROR, WARNING, CRITICAL, etc.)"
                        }
                    },
                    "required": ["file_path"]
                }
            },
            {
                "name": "search_errors",
                "description": "Search for specific error patterns in logs",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "file_path": {
                            "type": "string",
                            "description": "Path to the log file"
                        },
                        "pattern": {
                            "type": "string",
                            "description": "Error pattern to search for"
                        }
                    },
                    "required": ["file_path", "pattern"]
                }
            },
            {
                "name": "get_error_stats",
                "description": "Get statistics about errors in a log file",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "file_path": {
                            "type": "string",
                            "description": "Path to the log file"
                        }
                    },
                    "required": ["file_path"]
                }
            }
        ]
    
    async def list_resources(self) -> list[Dict[str, Any]]:
        """List available resources"""
        return [
            {
                "uri": "log://recent-errors",
                "name": "Recent Errors",
                "description": "Access to recently detected errors",
                "mimeType": "application/json"
            },
            {
                "uri": "log://error-patterns",
                "name": "Error Patterns",
                "description": "Common error patterns database",
                "mimeType": "application/json"
            }
        ]
    
    async def list_prompts(self) -> list[Dict[str, Any]]:
        """List available prompts"""
        return [
            {
                "name": "analyze_errors",
                "description": "Prompt for analyzing log errors",
                "arguments": [
                    {
                        "name": "log_content",
                        "description": "Content of the log file",
                        "required": True
                    }
                ]
            },
            {
                "name": "classify_error",
                "description": "Prompt for classifying error severity",
                "arguments": [
                    {
                        "name": "error_message",
                        "description": "Error message to classify",
                        "required": True
                    }
                ]
            }
        ]
    
    async def call_tool(self, tool_name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        """
        Execute a tool and return results
        
        Args:
            tool_name: Name of the tool to execute
            arguments: Tool arguments
            
        Returns:
            Tool execution results
        """
        if tool_name == "analyze_log_file":
            return await self._analyze_log_file(
                arguments.get("file_path"),
                arguments.get("error_types", [])
            )
        elif tool_name == "search_errors":
            return await self._search_errors(
                arguments.get("file_path"),
                arguments.get("pattern")
            )
        elif tool_name == "get_error_stats":
            return await self._get_error_stats(arguments.get("file_path"))
        else:
            return {"error": f"Unknown tool: {tool_name}"}
    
    async def _analyze_log_file(self, file_path: str, error_types: list) -> Dict[str, Any]:
        """Analyze log file for errors"""
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()
            
            errors = []
            for line_num, line in enumerate(content.split('\n'), 1):
                for error_type in error_types or ['ERROR', 'WARNING', 'CRITICAL', 'FATAL']:
                    if error_type in line.upper():
                        errors.append({
                            'line': line_num,
                            'type': error_type,
                            'message': line.strip()
                        })
            
            return {
                "success": True,
                "file": file_path,
                "errors_found": len(errors),
                "errors": errors,
                "timestamp": datetime.now().isoformat()
            }
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    async def _search_errors(self, file_path: str, pattern: str) -> Dict[str, Any]:
        """Search for specific error patterns"""
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()
            
            matches = []
            for line_num, line in enumerate(content.split('\n'), 1):
                if pattern.lower() in line.lower():
                    matches.append({
                        'line': line_num,
                        'content': line.strip()
                    })
            
            return {
                "success": True,
                "pattern": pattern,
                "matches_found": len(matches),
                "matches": matches
            }
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    async def _get_error_stats(self, file_path: str) -> Dict[str, Any]:
        """Get error statistics"""
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()
            
            stats = {
                'ERROR': 0,
                'WARNING': 0,
                'CRITICAL': 0,
                'FATAL': 0,
                'EXCEPTION': 0
            }
            
            lines = content.split('\n')
            for line in lines:
                line_upper = line.upper()
                for error_type in stats.keys():
                    if error_type in line_upper:
                        stats[error_type] += 1
            
            return {
                "success": True,
                "file": file_path,
                "total_lines": len(lines),
                "statistics": stats,
                "total_errors": sum(stats.values())
            }
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    async def read_resource(self, uri: str) -> Dict[str, Any]:
        """Read a resource by URI"""
        if uri == "log://recent-errors":
            return {
                "uri": uri,
                "mimeType": "application/json",
                "content": json.dumps({
                    "recent_errors": [
                        {"type": "ERROR", "message": "Connection timeout"},
                        {"type": "CRITICAL", "message": "Unauthorized access"}
                    ]
                })
            }
        elif uri == "log://error-patterns":
            return {
                "uri": uri,
                "mimeType": "application/json",
                "content": json.dumps({
                    "patterns": [
                        {"pattern": "Connection.*failed", "severity": "HIGH"},
                        {"pattern": "Out of memory", "severity": "CRITICAL"}
                    ]
                })
            }
        else:
            return {"error": f"Unknown resource: {uri}"}
    
    async def get_prompt(self, prompt_name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        """Get a prompt template"""
        if prompt_name == "analyze_errors":
            log_content = arguments.get("log_content", "")
            return {
                "name": prompt_name,
                "prompt": f"""Analyze the following log content and identify all errors:

{log_content}

Please provide:
1. List of all errors found
2. Severity classification
3. Potential root causes
4. Recommended fixes
"""
            }
        elif prompt_name == "classify_error":
            error_message = arguments.get("error_message", "")
            return {
                "name": prompt_name,
                "prompt": f"""Classify the severity and category of this error:

{error_message}

Provide:
1. Severity (CRITICAL/HIGH/MEDIUM/LOW)
2. Category (Database/Network/Auth/etc.)
3. Impact assessment
4. Recommended action
"""
            }
        else:
            return {"error": f"Unknown prompt: {prompt_name}"}


async def run_mcp_server():
    """
    Run the MCP server for log analysis
    """
    server = MCPLogServer()
    
    print("🚀 Starting MCP Log Analysis Server")
    print(f"Server: {server.name} v{server.version}")
    print("-" * 80)
    
    # Get server info
    info = server.get_server_info()
    print(f"\n📋 Server Info:")
    print(json.dumps(info, indent=2))
    
    # List available tools
    tools = await server.list_tools()
    print(f"\n🔧 Available Tools ({len(tools)}):")
    for tool in tools:
        print(f"  - {tool['name']}: {tool['description']}")
    
    # List available resources
    resources = await server.list_resources()
    print(f"\n📚 Available Resources ({len(resources)}):")
    for resource in resources:
        print(f"  - {resource['uri']}: {resource['name']}")
    
    # Example: Call a tool
    print("\n🧪 Example Tool Call: get_error_stats")
    result = await server.call_tool("get_error_stats", {"file_path": "example.log"})
    print(json.dumps(result, indent=2))
    
    print("\n✅ MCP Server demonstration complete")


if __name__ == "__main__":
    asyncio.run(run_mcp_server())

