// L2 adapter demo: Claude Agent SDK
//
// `withHarnesskit(bus, sdkOptions)` adds observer hooks to the SDK's
// hooks map (PreToolUse / PostToolUse / SessionStart / SessionEnd / …)
// and wraps `canUseTool` to surface approval.requested / approval.resolved.
// You can deny a tool from the bus and the adapter will translate that into
// a `permissionDecision: "deny"` for the SDK.
//
// Pre-reqs:
//   - the `claude` CLI must be on PATH (the Claude Agent SDK spawns it)
//   - ANTHROPIC_API_KEY OR ANTHROPIC_BASE_URL+key set
//   - we use POLO_CLAUDE_API_KEY against poloai.top by default if the
//     standard Anthropic env vars aren't present
//
// Run: pnpm --filter @harnesskit/examples demo:adapter-claude-agent-sdk

import { query } from '@anthropic-ai/claude-agent-sdk';
import { withHarnesskit } from '@harnesskit/adapter-claude-agent-sdk';
import { type AgentEvent, EventBus } from '@harnesskit/core';
import { denyTools, policyToInterceptor } from '@harnesskit/policy';

const main = async (): Promise<void> => {
  // Prefer real Anthropic creds; fall back to the polo proxy in this repo's .env.
  if (!process.env.ANTHROPIC_API_KEY && process.env.POLO_CLAUDE_API_KEY) {
    process.env.ANTHROPIC_API_KEY = process.env.POLO_CLAUDE_API_KEY;
    process.env.ANTHROPIC_BASE_URL = process.env.POLO_CLAUDE_BASE_URL ?? 'https://poloai.top';
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Set ANTHROPIC_API_KEY (or POLO_CLAUDE_API_KEY) to run this demo.');
    process.exit(1);
  }
  const model = process.env.POLO_CLAUDE_FAST_MODEL ?? 'claude-sonnet-4-5-20250929';

  console.log('=== Claude Agent SDK + harnesskit L2 adapter ===\n');

  const bus = new EventBus();
  const events: AgentEvent[] = [];
  bus.use({
    name: 'tap',
    on: (e) => {
      events.push(e);
    },
  });

  // Block file writes via the bus. The adapter translates the bus deny into
  // the SDK's permissionDecision: "deny" — Claude sees a denied result and
  // adapts.
  bus.use(policyToInterceptor(denyTools(['Write', 'Edit', 'Bash'])));

  const opts = withHarnesskit(
    { bus },
    {
      model,
      systemPrompt:
        'You are a research assistant. You may use Read tools, but never modify the filesystem.',
      // Allow only safe read-only tools. Claude Agent SDK still negotiates,
      // but harnesskit will deny Write/Edit/Bash if the model tries.
      allowedTools: ['Read', 'Glob', 'Grep'],
      permissionMode: 'default' as const,
      maxTurns: 4,
    },
  );

  const q = query({
    prompt: 'What files are at the root of this project? Just list them — do not modify anything.',
    options: opts,
  });

  // Drain the message stream so the SDK actually runs to completion.
  let lastText = '';
  for await (const msg of q) {
    if (msg.type === 'assistant') {
      const blocks = (msg.message?.content ?? []) as Array<{ type: string; text?: string }>;
      for (const b of blocks) {
        if (b.type === 'text' && typeof b.text === 'string') lastText = b.text;
      }
    }
    if (msg.type === 'result') break;
  }

  console.log(`final assistant text: ${lastText.slice(0, 200) || '(empty)'}\n`);

  const counts: Record<string, number> = {};
  for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;
  console.log('events emitted via Claude Agent SDK hooks:');
  for (const [k, v] of Object.entries(counts).sort()) console.log(`  ${k.padEnd(28)} ${v}`);

  const denied = events.filter((e) => e.type === 'tool.call.denied');
  if (denied.length > 0) {
    console.log(`\n${denied.length} tool call(s) denied — model received a deny via the SDK:`);
    for (const e of denied) {
      if (e.type === 'tool.call.denied') console.log(`  - ${e.call.name}: ${e.reason}`);
    }
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
