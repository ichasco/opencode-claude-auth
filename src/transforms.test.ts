import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  isOpenCodeBrandedEntry,
  repairToolPairs,
  stripToolPrefix,
  transformBody,
  transformResponseStream,
} from "./transforms.ts"

describe("transforms", () => {
  describe("isOpenCodeBrandedEntry", () => {
    it("matches 'OpenCode' brand name (case-insensitive)", () => {
      assert.equal(isOpenCodeBrandedEntry("You are OpenCode"), true)
      assert.equal(isOpenCodeBrandedEntry("you are opencode"), true)
      assert.equal(isOpenCodeBrandedEntry("OPENCODE docs"), true)
    })

    it("matches anomalyco GitHub org", () => {
      assert.equal(
        isOpenCodeBrandedEntry(
          "report at https://github.com/anomalyco/opencode",
        ),
        true,
      )
      assert.equal(isOpenCodeBrandedEntry("see anomalyco for details"), true)
    })

    it("matches OpenCode-specific env phrase 'Workspace root folder'", () => {
      assert.equal(
        isOpenCodeBrandedEntry(
          "Working directory: /x\nWorkspace root folder: /x",
        ),
        true,
      )
    })

    it("matches OpenCode-specific <directories> env tag", () => {
      assert.equal(
        isOpenCodeBrandedEntry("<directories>\n  /x\n</directories>"),
        true,
      )
    })

    it("does not match plain AGENTS.md project conventions", () => {
      const agentsMd = `## Project Conventions
- Use 2-space indentation
- Run \`npm test\` before committing
- Integration tests live in tests/integration/`
      assert.equal(isOpenCodeBrandedEntry(agentsMd), false)
    })

    it("does not match Claude Code env format", () => {
      const ccEnv = `Here is useful information about the environment you are running in:
<env>
Working directory: /home/user/project
Is directory a git repo: Yes
Platform: linux
Today's date: 2026-04-09
</env>`
      assert.equal(isOpenCodeBrandedEntry(ccEnv), false)
    })

    it("does not match generic skills description block", () => {
      const skills = `<available_skills>
  <skill>
    <name>test-driven-development</name>
    <description>Use when implementing features</description>
  </skill>
</available_skills>`
      assert.equal(isOpenCodeBrandedEntry(skills), false)
    })

    it("does not match unrelated words containing 'opencode' as substring", () => {
      // Word boundary should prevent false matches on compound words.
      assert.equal(isOpenCodeBrandedEntry("the opencoded scheme"), false)
      assert.equal(isOpenCodeBrandedEntry("reopencoded"), false)
    })

    it("does not match empty or short strings", () => {
      assert.equal(isOpenCodeBrandedEntry(""), false)
      assert.equal(isOpenCodeBrandedEntry("hello"), false)
    })

    it("does not match billing header or identity prefix", () => {
      assert.equal(
        isOpenCodeBrandedEntry(
          "x-anthropic-billing-header: cc_version=2.1.90.xxx; cc_entrypoint=cli; cch=abcde;",
        ),
        false,
      )
      assert.equal(
        isOpenCodeBrandedEntry(
          "You are Claude Code, Anthropic's official CLI for Claude.",
        ),
        false,
      )
    })
  })

  it("transformBody moves non-core system text to user message and prefixes tool names", () => {
    const input = JSON.stringify({
      system: [{ type: "text", text: "OpenCode and opencode" }],
      tools: [{ name: "search" }],
      messages: [
        { role: "user", content: [{ type: "tool_use", name: "lookup" }] },
      ],
    })

    const output = transformBody(input)
    assert.equal(typeof output, "string")
    const parsed = JSON.parse(output as string) as {
      system: Array<{ text: string }>
      tools: Array<{ name: string }>
      messages: Array<{
        content: Array<{ type?: string; text?: string; name?: string }>
      }>
    }

    // system should only contain the billing header (non-core text relocated)
    assert.equal(parsed.system.length, 1)
    assert.ok(
      parsed.system[0].text.startsWith("x-anthropic-billing-header:"),
      "system[0] should be the billing header",
    )
    // The original system text should now be prepended to the first user message
    assert.equal(parsed.messages[0].content[0].type, "text")
    assert.equal(parsed.messages[0].content[0].text, "OpenCode and opencode")
    assert.equal(parsed.tools[0].name, "mcp_search")
    assert.equal(parsed.messages[0].content[1].name, "mcp_lookup")
  })

  it("transformBody relocates non-core system text to user message", () => {
    const input = JSON.stringify({
      system: [
        {
          type: "text",
          text: "Use opencode-claude-auth plugin instructions as-is.",
        },
      ],
      messages: [{ role: "user", content: "hello" }],
    })

    const output = transformBody(input)
    assert.equal(typeof output, "string")
    const parsed = JSON.parse(output as string) as {
      system: Array<{ text: string }>
      messages: Array<{ content: string }>
    }

    // Non-core system text should be moved to user message
    assert.equal(parsed.system.length, 1) // only billing header
    assert.ok(
      parsed.messages[0].content.includes(
        "Use opencode-claude-auth plugin instructions as-is.",
      ),
    )
  })

  it("transformBody relocates URL/path system text to user message", () => {
    const input = JSON.stringify({
      system: [
        {
          type: "text",
          text: "OpenCode docs: https://example.com/opencode/docs and path /var/opencode/bin",
        },
      ],
      messages: [{ role: "user", content: "hello" }],
    })

    const output = transformBody(input)
    assert.equal(typeof output, "string")
    const parsed = JSON.parse(output as string) as {
      system: Array<{ text: string }>
      messages: Array<{ content: string }>
    }

    // Non-core system text should be relocated
    assert.equal(parsed.system.length, 1) // only billing header
    assert.ok(
      parsed.messages[0].content.includes(
        "OpenCode docs: https://example.com/opencode/docs and path /var/opencode/bin",
      ),
    )
  })

  it("transformBody injects billing header as system[0] with computed cch", () => {
    const input = JSON.stringify({
      system: [{ type: "text", text: "system prompt" }],
      messages: [{ role: "user", content: "hey" }],
    })

    const output = transformBody(input)
    const parsed = JSON.parse(output as string) as {
      system: Array<{ text: string }>
    }

    assert.ok(parsed.system[0].text.startsWith("x-anthropic-billing-header:"))
    assert.ok(
      parsed.system[0].text.includes("cch=fa690"),
      `Expected cch=fa690 for 'hey', got: ${parsed.system[0].text}`,
    )
  })

  it("transformBody billing header has no cache_control", () => {
    const input = JSON.stringify({
      system: [
        { type: "text", text: "prompt", cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: "test" }],
    })

    const output = transformBody(input)
    const parsed = JSON.parse(output as string) as {
      system: Array<{ text: string; cache_control?: unknown }>
    }

    // Billing header (system[0]) should not have cache_control
    assert.equal(
      parsed.system[0].cache_control,
      undefined,
      "Billing header must not have cache_control",
    )
  })

  it("transformBody splits concatenated identity prefix and keeps non-branded remainder in system", () => {
    const identity = "You are Claude Code, Anthropic's official CLI for Claude."
    const input = JSON.stringify({
      system: [
        {
          type: "text",
          text: `${identity}\nWorking directory: /home/test`,
        },
      ],
      messages: [{ role: "user", content: "test" }],
    })

    const output = transformBody(input)
    const parsed = JSON.parse(output as string) as {
      system: Array<{ type: string; text: string }>
      messages: Array<{ content: string }>
    }

    // system[0] = billing header, system[1] = identity prefix,
    // system[2] = non-branded remainder (stays in system[])
    assert.equal(parsed.system.length, 3)
    assert.ok(parsed.system[0].text.startsWith("x-anthropic-billing-header:"))
    assert.equal(parsed.system[1].text, identity)
    assert.equal(parsed.system[2].text, "Working directory: /home/test")
    // User message is unchanged (no injection)
    assert.equal(parsed.messages[0].content, "test")
  })

  it("transformBody preserves identity without cache_control and keeps non-branded remainder in system", () => {
    const identity = "You are Claude Code, Anthropic's official CLI for Claude."
    const input = JSON.stringify({
      system: [
        {
          type: "text",
          text: `${identity}\nMore content here`,
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
      messages: [{ role: "user", content: "test" }],
    })

    const output = transformBody(input)
    const parsed = JSON.parse(output as string) as {
      system: Array<{ text: string; cache_control?: unknown }>
      messages: Array<{ content: string }>
    }

    // Identity block should NOT have cache_control
    assert.equal(
      parsed.system[1].cache_control,
      undefined,
      "Identity block must not have cache_control",
    )
    // Remainder is non-branded, so it stays in system[] with its cache_control
    assert.equal(parsed.system.length, 3)
    assert.equal(parsed.system[2].text, "More content here")
    assert.deepEqual(parsed.system[2].cache_control, {
      type: "ephemeral",
      ttl: "1h",
    })
    // User message is unchanged
    assert.equal(parsed.messages[0].content, "test")
  })

  it("transformBody does not split identity-only system entry", () => {
    const identity = "You are Claude Code, Anthropic's official CLI for Claude."
    const input = JSON.stringify({
      system: [{ type: "text", text: identity }],
      messages: [{ role: "user", content: "test" }],
    })

    const output = transformBody(input)
    const parsed = JSON.parse(output as string) as {
      system: Array<{ text: string }>
    }

    // system[0] = billing, system[1] = identity (not split further)
    assert.equal(parsed.system.length, 2)
    assert.equal(parsed.system[1].text, identity)
  })

  it("transformBody removes duplicate billing headers and keeps non-branded text in system", () => {
    const input = JSON.stringify({
      system: [
        {
          type: "text",
          text: "x-anthropic-billing-header: cc_version=old; cc_entrypoint=cli; cch=00000;",
        },
        { type: "text", text: "prompt" },
      ],
      messages: [{ role: "user", content: "hey" }],
    })

    const output = transformBody(input)
    const parsed = JSON.parse(output as string) as {
      system: Array<{ text: string }>
      messages: Array<{ content: string }>
    }

    const billingEntries = parsed.system.filter((e) =>
      e.text.startsWith("x-anthropic-billing-header:"),
    )
    assert.equal(
      billingEntries.length,
      1,
      "Should have exactly one billing header",
    )
    assert.ok(
      billingEntries[0].text.includes("cch=fa690"),
      `Expected computed cch, got: ${billingEntries[0].text}`,
    )
    // "prompt" is non-branded, so it stays in system[]
    const promptEntry = parsed.system.find((e) => e.text === "prompt")
    assert.ok(promptEntry, "'prompt' should remain in system array")
    // User message is unchanged (no prefix injection)
    assert.equal(parsed.messages[0].content, "hey")
  })

  it("transformBody keeps multiple non-branded system entries in the system array", () => {
    const identity = "You are Claude Code, Anthropic's official CLI for Claude."
    const input = JSON.stringify({
      system: [
        { type: "text", text: identity },
        { type: "text", text: "Custom instructions block A" },
        { type: "text", text: "Custom instructions block B" },
      ],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
      ],
    })

    const output = transformBody(input)
    const parsed = JSON.parse(output as string) as {
      system: Array<{ text: string }>
      messages: Array<{
        content: Array<{ type: string; text: string }>
      }>
    }

    // system should have billing + identity + both custom blocks (all stay)
    assert.equal(parsed.system.length, 4)
    assert.ok(parsed.system[0].text.startsWith("x-anthropic-billing-header:"))
    assert.equal(parsed.system[1].text, identity)
    assert.equal(parsed.system[2].text, "Custom instructions block A")
    assert.equal(parsed.system[3].text, "Custom instructions block B")
    // User message is unchanged (no prefix injection)
    assert.equal(parsed.messages[0].content.length, 1)
    assert.equal(parsed.messages[0].content[0].text, "hello")
  })

  it("transformBody keeps plain AGENTS.md content in system array", () => {
    const agentsMd = `## Project Conventions
- Use 2-space indentation
- Run \`pnpm test\` before committing`
    const input = JSON.stringify({
      system: [{ type: "text", text: agentsMd }],
      messages: [{ role: "user", content: "hello" }],
    })

    const output = transformBody(input)
    const parsed = JSON.parse(output as string) as {
      system: Array<{ text: string }>
      messages: Array<{ content: string }>
    }

    // AGENTS.md content has no OpenCode markers — stays in system[]
    assert.equal(parsed.system.length, 2)
    assert.ok(parsed.system[0].text.startsWith("x-anthropic-billing-header:"))
    assert.equal(parsed.system[1].text, agentsMd)
    // User message unchanged
    assert.equal(parsed.messages[0].content, "hello")
  })

  it("transformBody keeps Claude Code-format env block in system array", () => {
    const ccEnvBlock = `Here is useful information about the environment you are running in:
<env>
Working directory: /home/user/project
Is directory a git repo: Yes
Platform: linux
Today's date: 2026-04-09
</env>`
    const input = JSON.stringify({
      system: [{ type: "text", text: ccEnvBlock }],
      messages: [{ role: "user", content: "hello" }],
    })

    const output = transformBody(input)
    const parsed = JSON.parse(output as string) as {
      system: Array<{ text: string }>
      messages: Array<{ content: string }>
    }

    // CC-format env has no OpenCode-specific features — stays in system[]
    assert.equal(parsed.system.length, 2)
    assert.equal(parsed.system[1].text, ccEnvBlock)
    assert.equal(parsed.messages[0].content, "hello")
  })

  it("transformBody keeps generic skills block in system array", () => {
    const skillsBlock = `<available_skills>
  <skill>
    <name>test-driven-development</name>
    <description>Use when implementing features</description>
  </skill>
</available_skills>`
    const input = JSON.stringify({
      system: [{ type: "text", text: skillsBlock }],
      messages: [{ role: "user", content: "hello" }],
    })

    const output = transformBody(input)
    const parsed = JSON.parse(output as string) as {
      system: Array<{ text: string }>
      messages: Array<{ content: string }>
    }

    // Skills block has no OpenCode markers — stays in system[]
    assert.equal(parsed.system.length, 2)
    assert.equal(parsed.system[1].text, skillsBlock)
  })

  it("transformBody relocates entry containing anomalyco URL", () => {
    const brandedEntry =
      "Report feedback at https://github.com/anomalyco/opencode/issues"
    const input = JSON.stringify({
      system: [{ type: "text", text: brandedEntry }],
      messages: [{ role: "user", content: "hello" }],
    })

    const output = transformBody(input)
    const parsed = JSON.parse(output as string) as {
      system: Array<{ text: string }>
      messages: Array<{ content: string }>
    }

    // Branded entry is relocated; system has only billing header
    assert.equal(parsed.system.length, 1)
    assert.ok(parsed.system[0].text.startsWith("x-anthropic-billing-header:"))
    assert.ok(parsed.messages[0].content.includes(brandedEntry))
  })

  it("transformBody relocates OpenCode env block with <directories> tag", () => {
    const opencodeEnv = `Here is some useful information about the environment you are running in:
<env>
  Working directory: /home/user/project
  Workspace root folder: /home/user/project
</env>
<directories>
  /home/user/project
</directories>`
    const input = JSON.stringify({
      system: [{ type: "text", text: opencodeEnv }],
      messages: [{ role: "user", content: "hello" }],
    })

    const output = transformBody(input)
    const parsed = JSON.parse(output as string) as {
      system: Array<{ text: string }>
      messages: Array<{ content: string }>
    }

    // Contains BOTH 'Workspace root folder' and '<directories>' — relocated
    assert.equal(parsed.system.length, 1)
    assert.ok(parsed.messages[0].content.includes("<directories>"))
    assert.ok(parsed.messages[0].content.includes("Workspace root folder"))
  })

  it("transformBody surgically relocates only branded entries in mixed system input", () => {
    const identity = "You are Claude Code, Anthropic's official CLI for Claude."
    const agentsMd = "## Conventions\n- Use 2-space indentation"
    const ccEnvBlock = `<env>\nWorking directory: /x\nIs directory a git repo: Yes\n</env>`
    const opencodeCore =
      "You are OpenCode, the best coding agent on the planet."
    const skillsBlock = `<available_skills>\n  <skill>\n    <name>tdd</name>\n  </skill>\n</available_skills>`

    const input = JSON.stringify({
      system: [
        { type: "text", text: identity },
        { type: "text", text: agentsMd },
        { type: "text", text: ccEnvBlock },
        { type: "text", text: opencodeCore },
        { type: "text", text: skillsBlock },
      ],
      messages: [{ role: "user", content: "hello" }],
    })

    const output = transformBody(input)
    const parsed = JSON.parse(output as string) as {
      system: Array<{ text: string }>
      messages: Array<{ content: string }>
    }

    // Kept in system: billing + identity + agentsMd + ccEnvBlock + skillsBlock
    assert.equal(parsed.system.length, 5)
    assert.ok(parsed.system[0].text.startsWith("x-anthropic-billing-header:"))
    assert.equal(parsed.system[1].text, identity)
    assert.equal(parsed.system[2].text, agentsMd)
    assert.equal(parsed.system[3].text, ccEnvBlock)
    assert.equal(parsed.system[4].text, skillsBlock)
    // Only opencodeCore is relocated to user message
    assert.ok(parsed.messages[0].content.includes(opencodeCore))
    assert.ok(!parsed.messages[0].content.includes(agentsMd))
  })

  it("transformBody keeps system intact when no messages exist", () => {
    const input = JSON.stringify({
      system: [{ type: "text", text: "Some instructions" }],
      messages: [],
    })

    const output = transformBody(input)
    const parsed = JSON.parse(output as string) as {
      system: Array<{ text: string }>
    }

    // With no messages to relocate into, system stays as-is
    // (billing header + original text)
    assert.ok(parsed.system.length >= 2)
  })

  it("transformBody strips output_config.effort for haiku", () => {
    const input = JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      output_config: { effort: "high" },
      messages: [{ role: "user", content: "test" }],
    })

    const output = transformBody(input)
    const parsed = JSON.parse(output as string) as {
      output_config?: Record<string, unknown>
    }

    assert.equal(
      parsed.output_config,
      undefined,
      "output_config should be removed when effort was its only field",
    )
  })

  it("transformBody strips effort but keeps other output_config fields for haiku", () => {
    const input = JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      output_config: { effort: "high", max_tokens: 1024 },
      messages: [{ role: "user", content: "test" }],
    })

    const output = transformBody(input)
    const parsed = JSON.parse(output as string) as {
      output_config?: { effort?: string; max_tokens?: number }
    }

    assert.ok(
      parsed.output_config,
      "output_config should be preserved when other fields exist",
    )
    assert.equal(parsed.output_config!.max_tokens, 1024)
    assert.equal(
      parsed.output_config!.effort,
      undefined,
      "effort should be stripped",
    )
  })

  it("transformBody strips thinking.effort but preserves other fields for haiku", () => {
    const input = JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      thinking: { type: "enabled", effort: "high" },
      messages: [{ role: "user", content: "test" }],
    })

    const output = transformBody(input)
    const parsed = JSON.parse(output as string) as {
      thinking?: Record<string, unknown>
    }

    assert.ok(
      parsed.thinking,
      "thinking should be preserved when non-effort fields remain",
    )
    assert.equal(
      parsed.thinking!.effort,
      undefined,
      "effort should be stripped",
    )
    assert.equal(parsed.thinking!.type, "enabled", "type should be preserved")
  })

  it("transformBody removes thinking entirely when effort is its only field for haiku", () => {
    const input = JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      thinking: { effort: "high" },
      messages: [{ role: "user", content: "test" }],
    })

    const output = transformBody(input)
    const parsed = JSON.parse(output as string) as {
      thinking?: Record<string, unknown>
    }

    assert.equal(
      parsed.thinking,
      undefined,
      "thinking should be removed when effort was its only field",
    )
  })

  it("transformBody preserves thinking for haiku when effort is absent", () => {
    const input = JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      thinking: { type: "enabled" },
      messages: [{ role: "user", content: "test" }],
    })

    const output = transformBody(input)
    const parsed = JSON.parse(output as string) as {
      thinking?: Record<string, unknown>
    }

    assert.deepEqual(
      parsed.thinking,
      { type: "enabled" },
      "thinking without effort should pass through unchanged",
    )
  })

  it("transformBody preserves effort for non-haiku models", () => {
    const input = JSON.stringify({
      model: "claude-opus-4-6",
      output_config: { effort: "high" },
      thinking: { type: "enabled", effort: "high" },
      messages: [{ role: "user", content: "test" }],
    })

    const output = transformBody(input)
    const parsed = JSON.parse(output as string) as {
      output_config?: { effort?: string }
      thinking?: { effort?: string }
    }

    assert.equal(
      parsed.output_config!.effort,
      "high",
      "output_config.effort should remain for opus",
    )
    assert.equal(
      parsed.thinking!.effort,
      "high",
      "thinking.effort should remain for opus",
    )
  })

  it("transformBody handles haiku without effort-related fields", () => {
    const input = JSON.stringify({
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "test" }],
    })

    const output = transformBody(input)
    const parsed = JSON.parse(output as string) as {
      output_config?: unknown
      thinking?: unknown
    }

    assert.equal(parsed.output_config, undefined)
    assert.equal(parsed.thinking, undefined)
  })

  it("stripToolPrefix removes mcp_ from response payload names", () => {
    const input = '{"name":"mcp_search","type":"tool_use"}'
    assert.equal(stripToolPrefix(input), '{"name": "search","type":"tool_use"}')
  })

  it("transformResponseStream passes error responses through without SSE parsing", async () => {
    const errorBody = JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "Test error message",
      },
    })
    const response = new Response(errorBody, {
      status: 400,
      statusText: "Bad Request",
      headers: { "content-type": "application/json" },
    })

    const transformed = transformResponseStream(response)
    assert.equal(transformed.status, 400)
    assert.equal(transformed.statusText, "Bad Request")

    const text = await transformed.text()
    assert.equal(text, errorBody, "Error body should pass through unchanged")
  })

  it("transformResponseStream passes 401 errors through intact", async () => {
    const errorBody = JSON.stringify({
      type: "error",
      error: {
        type: "authentication_error",
        message: "OAuth token has expired.",
      },
    })
    const response = new Response(errorBody, { status: 401 })
    const transformed = transformResponseStream(response)
    assert.equal(transformed.status, 401)
    const text = await transformed.text()
    const parsed = JSON.parse(text) as { error: { message: string } }
    assert.equal(parsed.error.message, "OAuth token has expired.")
  })

  it("transformResponseStream passes 429 errors through intact", async () => {
    const errorBody = JSON.stringify({
      type: "error",
      error: { type: "rate_limit_error", message: "Rate limited" },
    })
    const response = new Response(errorBody, {
      status: 429,
      headers: { "retry-after": "30" },
    })
    const transformed = transformResponseStream(response)
    assert.equal(transformed.status, 429)
    assert.equal(transformed.headers.get("retry-after"), "30")
    const text = await transformed.text()
    assert.ok(text.includes("Rate limited"))
  })

  it("transformResponseStream passes 529 overloaded errors through", async () => {
    const response = new Response("Overloaded", { status: 529 })
    const transformed = transformResponseStream(response)
    assert.equal(transformed.status, 529)
    const text = await transformed.text()
    assert.equal(text, "Overloaded")
  })

  it("transformResponseStream still strips tool prefixes in error bodies", async () => {
    // stripToolPrefix matches the pattern "name": "mcp_..."
    const errorBody = '{"name": "mcp_search", "error": "failed"}'
    const response = new Response(errorBody, { status: 400 })
    const transformed = transformResponseStream(response)
    const text = await transformed.text()
    assert.ok(
      text.includes('"name": "search"'),
      "Should strip mcp_ prefix even in error bodies",
    )
    assert.ok(
      !text.includes("mcp_search"),
      "Should not contain mcp_search after stripping",
    )
  })

  it("transformResponseStream rewrites streamed tool names", async () => {
    const payload = '{"name":"mcp_lookup"}'
    const response = new Response(payload)
    const transformed = transformResponseStream(response)
    const text = await transformed.text()

    assert.equal(text, '{"name": "lookup"}')
  })

  it("transformResponseStream buffers across chunks until event boundary", async () => {
    const chunk1 = 'data: {"name":"mc'
    const chunk2 = 'p_search"}\n\ndata: {"type":"done"}\n\n'
    const encoder = new TextEncoder()

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(chunk1))
        controller.enqueue(encoder.encode(chunk2))
        controller.close()
      },
    })

    const response = new Response(stream)
    const transformed = transformResponseStream(response)
    const text = await transformed.text()

    assert.ok(
      text.includes('"name": "search"'),
      `Expected stripped name in: ${text}`,
    )
    assert.ok(
      !text.includes("mcp_search"),
      `Should not contain mcp_search in: ${text}`,
    )
  })

  it("transformResponseStream withholds output until event boundary arrives", async () => {
    const encoder = new TextEncoder()
    let sendBoundary: (() => void) | undefined

    const source = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"name":"mcp_test"}'))
        sendBoundary = () => {
          controller.enqueue(encoder.encode("\n\n"))
          controller.close()
        }
      },
    })

    const response = new Response(source)
    const transformed = transformResponseStream(response)
    const reader = transformed.body!.getReader()

    const pending = reader.read()
    const raceTimeout = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), 50),
    )

    const first = await Promise.race([pending, raceTimeout])
    assert.equal(
      first,
      "timeout",
      "Expected no output before boundary, but got a chunk",
    )

    sendBoundary!()

    const { done, value } = await pending
    assert.equal(done, false)
    const decoder = new TextDecoder()
    const text = decoder.decode(value)
    assert.ok(
      text.includes('"name": "test"'),
      `Expected stripped name: ${text}`,
    )
    assert.ok(
      !text.includes("mcp_test"),
      `Should not contain mcp_test: ${text}`,
    )

    const final = await reader.read()
    assert.equal(final.done, true)
  })

  describe("repairToolPairs", () => {
    it("removes tool_use blocks with no matching tool_result", () => {
      const messages = [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_orphan", name: "search" }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "no tool_result here" }],
        },
      ]
      const result = repairToolPairs(messages)
      // The assistant message with only the orphaned tool_use should be removed
      assert.equal(result.length, 1)
      assert.equal(result[0].role, "user")
    })

    it("removes tool_result blocks with no matching tool_use", () => {
      const messages = [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_orphan", content: "ok" },
          ],
        },
      ]
      const result = repairToolPairs(messages)
      // The user message with only the orphaned tool_result should be removed
      assert.equal(result.length, 0)
    })

    it("preserves text blocks when removing orphaned tool_use", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "text", text: "I will search for that." },
            { type: "tool_use", id: "toolu_orphan", name: "search" },
          ],
        },
      ]
      const result = repairToolPairs(messages)
      assert.equal(result.length, 1)
      assert.deepEqual(result[0].content, [
        { type: "text", text: "I will search for that." },
      ])
    })

    it("does not modify valid tool_use/tool_result pairs", () => {
      const messages = [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_valid", name: "search" }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_valid", content: "ok" },
          ],
        },
      ]
      const result = repairToolPairs(messages)
      assert.equal(result.length, 2)
      assert.deepEqual(result, messages)
    })

    it("passes through messages with no tool blocks", () => {
      const messages = [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        { role: "assistant", content: [{ type: "text", text: "world" }] },
      ]
      const result = repairToolPairs(messages)
      assert.deepEqual(result, messages)
    })

    it("handles mix of valid and orphaned tool blocks", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_valid", name: "search" },
            { type: "tool_use", id: "toolu_orphan", name: "lookup" },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_valid", content: "ok" },
          ],
        },
      ]
      const result = repairToolPairs(messages)
      assert.equal(result.length, 2)
      // Only the valid tool_use remains
      assert.deepEqual(result[0].content, [
        { type: "tool_use", id: "toolu_valid", name: "search" },
      ])
      // tool_result for valid stays
      assert.deepEqual(result[1].content, [
        { type: "tool_result", tool_use_id: "toolu_valid", content: "ok" },
      ])
    })

    it("preserves messages with string content", () => {
      const messages = [
        { role: "user", content: "just a string" },
        { role: "assistant", content: "response string" },
      ]
      const result = repairToolPairs(messages)
      assert.deepEqual(result, messages)
    })

    it("handles multiple valid pairs", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_a", name: "search" },
            { type: "tool_use", id: "toolu_b", name: "read" },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_a", content: "res_a" },
            { type: "tool_result", tool_use_id: "toolu_b", content: "res_b" },
          ],
        },
      ]
      const result = repairToolPairs(messages)
      assert.deepEqual(result, messages)
    })
  })

  it("transformBody removes orphaned tool_use blocks from messages", () => {
    const input = JSON.stringify({
      system: [{ type: "text", text: "prompt" }],
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_orphan", name: "search" }],
        },
        { role: "user", content: "hello" },
      ],
    })

    const output = transformBody(input)
    const parsed = JSON.parse(output as string) as {
      messages: Array<{ role: string; content: unknown }>
    }

    // Orphaned tool_use message should be removed.
    // The user message remains, with the relocated system "prompt" prepended.
    assert.equal(parsed.messages.length, 1)
    assert.equal(parsed.messages[0].role, "user")
    assert.ok(
      (parsed.messages[0].content as string).includes("hello"),
      "User message content should be preserved",
    )
  })

  it("transformResponseStream flushes remaining buffered data on stream end", async () => {
    const encoder = new TextEncoder()
    const chunk1 = 'data: {"name":"mcp_alpha"}\n\n'
    const chunk2 = 'data: {"name":"mcp_beta"}'

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(chunk1))
        controller.enqueue(encoder.encode(chunk2))
        controller.close()
      },
    })

    const response = new Response(stream)
    const transformed = transformResponseStream(response)
    const text = await transformed.text()

    assert.ok(
      text.includes('"name": "alpha"'),
      `Expected alpha stripped in: ${text}`,
    )
    assert.ok(
      text.includes('"name": "beta"'),
      `Expected beta stripped in: ${text}`,
    )
    assert.ok(
      !text.includes("mcp_alpha"),
      `Should not contain mcp_alpha in: ${text}`,
    )
    assert.ok(
      !text.includes("mcp_beta"),
      `Should not contain mcp_beta in: ${text}`,
    )
  })
})
