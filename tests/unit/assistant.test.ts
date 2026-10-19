import { afterEach, describe, expect, it } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { Assistant, SYSTEM_PROMPT, validateToolInput, type AssistantToolHost } from '../../build/app/src/main/assistant';
import type { AssistantEvent } from '../../build/app/src/shared/types';
import { mockClaude } from './mock-claude';

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanup) await c();
  cleanup = [];
});

function host(proposals: string[]): AssistantToolHost {
  return {
    context: async () => ({ context: 'test' }),
    listResources: async (kind) => ({ kind, items: [{ name: 'web-1', status: 'CrashLoopBackOff' }] }),
    getResource: async () => 'kind: Pod',
    events: async () => [],
    podLogs: async () => 'boom',
    metrics: async () => ({}),
    securitySummary: async () => ({ score: 90 }),
    proposeChange: async (summary) => {
      proposals.push(summary);
      return { ok: true, issues: [] };
    },
  };
}

function setup(url: string, proposals: string[], model: 'claude-opus-5-5' | 'claude-haiku-5-5' = 'claude-opus-5-5') {
  const events: AssistantEvent[] = [];
  const a = new Assistant({
    client: () => new Anthropic({ apiKey: 'test-key-000000000000', baseURL: url, maxRetries: 0 }),
    host: host(proposals),
    emit: (e) => events.push(e),
    model: () => model,
    effort: () => 'medium',
  });
  return { a, events };
}

describe('Assistant tool loop', () => {
  it('streams text, runs read-only tools, forwards proposals and sends a well-formed request', async () => {
    const api = await mockClaude([
      { blocks: [{ type: 'text', text: 'Checking pods. ' }, { type: 'tool_use', id: 'toolu_1', name: 'list_resources', input: { kind: 'pods', namespace: 'shop' } }, { type: 'tool_use', id: 'toolu_2', name: 'get_pod_logs', input: { namespace: 'shop', pod: 'web-1' } }], stop: 'tool_use' },
      { blocks: [{ type: 'tool_use', id: 'toolu_3', name: 'propose_change', input: { summary: 'Raise memory limit', yaml: 'apiVersion: v1\nkind: ConfigMap\nmetadata: {name: x}\n' } }], stop: 'tool_use' },
      { blocks: [{ type: 'text', text: 'web-1 is crash looping; I proposed a fix.' }], stop: 'end_turn' },
    ]);
    cleanup.push(api.close);
    const proposals: string[] = [];
    const { a, events } = setup(api.url, proposals);
    await a.send('c1', 'Why is web failing?', 'namespace: shop');

    expect(events.filter((e) => e.type === 'text').map((e) => e.text).join('')).toBe('Checking pods. \n\nweb-1 is crash looping; I proposed a fix.');
    expect(events.filter((e) => e.type === 'tool').map((e) => e.tool!.name)).toEqual(['list_resources', 'get_pod_logs', 'propose_change']);
    expect(events.at(-1)?.type).toBe('done');
    expect(proposals).toEqual(['Raise memory limit']);

    const first = api.requests[0];
    expect(first.body.model).toBe('claude-opus-5-5');
    expect(first.body.fallbacks).toBe('default');
    expect(first.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
    expect(first.body.output_config).toEqual({ effort: 'medium' });
    expect(first.body.system).toBe(SYSTEM_PROMPT);
    expect(first.body.stream).toBe(true);
    expect(first.body.tools.every((t: any) => t.eager_input_streaming === true)).toBe(true);
    expect(first.body.messages[0].content).toContain('<context>\nnamespace: shop\n</context>');
    // Both tool results of turn 1 return together in one user message, and the history is append-only.
    const second = api.requests[1].body.messages;
    expect(second.at(-1).role).toBe('user');
    expect(second.at(-1).content.map((c: any) => c.tool_use_id)).toEqual(['toolu_1', 'toolu_2']);
    expect(second.at(-1).content[1].content).toBe('boom');
    const third = api.requests[2].body.messages;
    expect(third.at(-1).content[0].content).toMatch(/NOT been applied/);
    expect(third.slice(0, second.length)).toEqual(second);
  });

  it('returns an error result for invalid tool input instead of running the tool', async () => {
    const api = await mockClaude([
      { blocks: [{ type: 'tool_use', id: 'toolu_1', name: 'get_pod_logs', input: { pod: 'x' } }], stop: 'tool_use' },
      { blocks: [{ type: 'text', text: 'ok' }], stop: 'end_turn' },
    ]);
    cleanup.push(api.close);
    const { a } = setup(api.url, []);
    await a.send('c2', 'logs?');
    const result = api.requests[1].body.messages.at(-1).content[0];
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('INVALID_INPUT');
  });

  it('handles refusals without running tools and keeps the conversation usable', async () => {
    const api = await mockClaude([
      { blocks: [{ type: 'text', text: 'partial' }, { type: 'tool_use', id: 'toolu_x', name: 'get_context', input: {} }], stop: 'refusal' },
      { blocks: [{ type: 'text', text: 'second answer' }], stop: 'end_turn' },
    ]);
    cleanup.push(api.close);
    const { a, events } = setup(api.url, []);
    await a.send('c3', 'something');
    expect(events.some((e) => e.type === 'error' && /declined/.test(e.error!))).toBe(true);
    expect(events.some((e) => e.type === 'tool')).toBe(false);
    await a.send('c3', 'follow-up');
    const msgs = api.requests[1].body.messages;
    expect(msgs[1].content.some((b: any) => b.type === 'tool_use')).toBe(false);
    expect(msgs.at(-1)).toEqual({ role: 'user', content: 'follow-up' });
  });

  it('reports authentication errors clearly and omits fallbacks for Haiku', async () => {
    const api = await mockClaude([{ blocks: [], stop: 'end_turn', status: 401 }]);
    cleanup.push(api.close);
    const { a, events } = setup(api.url, [], 'claude-haiku-5-5');
    await a.send('c4', 'hi');
    expect(events.find((e) => e.type === 'error')?.error).toMatch(/API key was rejected/);
    expect(api.requests[0].body.fallbacks).toBeUndefined();
    expect(api.requests[0].headers['anthropic-beta'] ?? '').not.toContain('server-side-fallback');
  });

  it('explains how to set up when no client is configured', async () => {
    const events: AssistantEvent[] = [];
    const a = new Assistant({ client: () => null, host: host([]), emit: (e) => events.push(e), model: () => 'claude-opus-5-5', effort: () => 'medium' });
    await a.send('c5', 'hi');
    expect(events[0]).toMatchObject({ type: 'error' });
    expect(events[0].error).toMatch(/Settings/);
  });

  it('validates tool inputs', () => {
    expect(validateToolInput('list_resources', { kind: 'pods' })).toBeNull();
    expect(validateToolInput('list_resources', {})).toMatch(/kind/);
    expect(validateToolInput('propose_change', { summary: 's' })).toMatch(/yaml/);
    expect(validateToolInput('rm_rf', {})).toMatch(/unknown/);
  });
});

describe('Assistant ECS tools', () => {
  it('investigates ECS with read-only tools and returns their results to the model', async () => {
    const api = await mockClaude([
      {
        blocks: [
          { type: 'tool_use', id: 'toolu_e1', name: 'ecs_list_tasks', input: { cluster: 'shop-prod', service: 'worker', status: 'STOPPED' } },
          { type: 'tool_use', id: 'toolu_e2', name: 'ecs_get_logs', input: { cluster: 'shop-prod', service: 'worker', minutes: 30 } },
          { type: 'tool_use', id: 'toolu_e3', name: 'ecs_describe_service', input: { cluster: 'shop-prod' } },
        ],
        stop: 'tool_use',
      },
      { blocks: [{ type: 'text', text: 'worker exits with code 1: the database is unreachable.' }], stop: 'end_turn' },
    ]);
    cleanup.push(api.close);
    const calls: string[] = [];
    const events: AssistantEvent[] = [];
    const a = new Assistant({
      client: () => new Anthropic({ apiKey: 'test-key-000000000000', baseURL: api.url, maxRetries: 0 }),
      host: {
        ...host([]),
        ecs: {
          clusters: async () => [],
          services: async () => [],
          service: async () => ({}),
          tasks: async (c, s, st) => (calls.push(`tasks ${c} ${s} ${st}`), [{ id: 't1', stopCode: 'EssentialContainerExited', containers: [{ exitCode: 1 }] }]),
          taskDefinition: async () => '{}',
          logs: async (c, o) => (calls.push(`logs ${c} ${o.service} ${o.minutes}`), 'ERROR connect ECONNREFUSED db:5432'),
          metrics: async () => ({}),
          securityScan: async () => ({}),
        },
      },
      emit: (e) => events.push(e),
      model: () => 'claude-opus-5-5',
      effort: () => 'medium',
    });
    await a.send('e1', 'Why does worker keep failing?');
    expect(calls).toEqual(['tasks shop-prod worker STOPPED', 'logs shop-prod worker 30']);
    const results = (api.requests[1].body.messages.at(-1).content as any[]).map((b) => [b.tool_use_id, b.is_error ?? false, String(b.content)]);
    expect(results[0]).toEqual(['toolu_e1', false, expect.stringContaining('EssentialContainerExited')]);
    expect(results[1]).toEqual(['toolu_e2', false, 'ERROR connect ECONNREFUSED db:5432']);
    expect(results[2][0]).toBe('toolu_e3');
    expect(results[2][1]).toBe(true); // missing service name is rejected before the host is called
    expect(api.requests[0].body.tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(['ecs_list_clusters', 'ecs_get_logs', 'ecs_security_scan']));
    expect(SYSTEM_PROMPT).toContain('Amazon ECS');
  });

  it('validates ECS tool inputs', () => {
    expect(validateToolInput('ecs_list_clusters', {})).toBeNull();
    expect(validateToolInput('ecs_list_tasks', { cluster: 'c', status: 'PENDING' })).toMatch(/RUNNING or STOPPED/);
    expect(validateToolInput('ecs_get_logs', { cluster: 'c' })).toMatch(/service or task/);
    expect(validateToolInput('ecs_get_task_definition', {})).toMatch(/task_definition/);
  });
});
