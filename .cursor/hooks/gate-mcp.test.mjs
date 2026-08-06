import assert from "node:assert/strict";
import test from "node:test";
import { classifyMcp } from "./gate-mcp.mjs";

test("MCP github create_issue → ask", () => {
  assert.equal(
    classifyMcp({ server: "github", tool_name: "create_issue" }),
    "ask",
  );
});

test("MCP context7 → allow", () => {
  assert.equal(classifyMcp({ server: "context7", tool_name: "query-docs" }), "allow");
});

test("MCP playwright → ask", () => {
  assert.equal(classifyMcp({ server: "playwright", tool_name: "navigate" }), "ask");
});

test("MCP tool_name fetch → ask", () => {
  assert.equal(classifyMcp({ server: "other", tool_name: "web_fetch" }), "ask");
});

test("MCP chunkhound → allow", () => {
  assert.equal(classifyMcp({ server: "chunkhound", tool_name: "search" }), "allow");
});
