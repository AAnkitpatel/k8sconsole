import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type Block = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown };
export interface Turn {
  blocks: Block[];
  stop: string;
  status?: number;
}

/** Mock Messages API that streams scripted turns as server-sent events. */
export async function mockClaude(turns: Turn[]) {
  const requests: Array<{ body: any; headers: http.IncomingHttpHeaders }> = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    requests.push({ body: JSON.parse(raw), headers: req.headers });
    const turn = turns.shift();
    if (!turn || turn.status) {
      res.writeHead(turn?.status ?? 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('message_start', { type: 'message_start', message: { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
    turn.blocks.forEach((b, index) => {
      if (b.type === 'text') {
        send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
        send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } });
      } else {
        send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
        send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
      }
      send('content_block_stop', { type: 'content_block_stop', index });
    });
    send('message_delta', { type: 'message_delta', delta: { stop_reason: turn.stop, stop_sequence: null }, usage: { output_tokens: 20 } });
    send('message_stop', { type: 'message_stop' });
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}

