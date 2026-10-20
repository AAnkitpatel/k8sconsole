import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { decodeMessage, encodeMessage, PayloadType, SsmSession, uuidFromWire, uuidToWire, type AgentMessage, type SocketLike } from '../../build/app/src/main/aws/ssm-session';
import { AwsWorkspace } from '../../build/app/src/main/aws/controller';
import type { AwsClients, Sender } from '../../build/app/src/main/aws/session';

/** A fake Session Manager endpoint: records what the client sends and lets the test play the agent. */
class FakeSocket implements SocketLike {
  binaryType = '';
  readyState = 0;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  text: string[] = [];
  sent: AgentMessage[] = [];
  closed = false;
  constructor(public url: string) {}
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  send(data: string | ArrayBufferLike | Uint8Array) {
    if (typeof data === 'string') this.text.push(data);
    else this.sent.push(decodeMessage(Buffer.from(data as Uint8Array)));
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  agent(m: Partial<AgentMessage> & { messageType: string; payloadType: number; payload: Buffer; sequenceNumber: number }) {
    const bytes = encodeMessage({ flags: 0, ...m });
    this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  }
  output(seq: number, text: string, payloadType: number = PayloadType.Output) {
    this.agent({ messageType: 'output_stream_data', sequenceNumber: seq, payloadType, payload: Buffer.from(text) });
  }
  inputs() {
    return this.sent.filter((m) => m.messageType === 'input_stream_data');
  }
  acks() {
    return this.sent.filter((m) => m.messageType === 'acknowledge').map((m) => JSON.parse(m.payload.toString()));
  }
}

function session(extra: Partial<ConstructorParameters<typeof SsmSession>[0]> = {}) {
  let sock!: FakeSocket;
  const out: string[] = [];
  const closes: Array<string | undefined> = [];
  const s = new SsmSession({
    streamUrl: 'wss://ssmmessages.eu-west-2.amazonaws.com/v1/data-channel/s-1?role=publish_subscribe',
    token: 'TOKEN',
    cols: 100,
    rows: 30,
    onData: (d) => out.push(d),
    onClose: (e) => closes.push(e),
    socket: (url) => (sock = new FakeSocket(url)),
    ...extra,
  }).start();
  sock.open();
  return { s, sock, out, closes };
}

afterEach(() => vi.useRealTimers());

describe('Session Manager message codec', () => {
  it('round-trips a message with the agent header layout', () => {
    const payload = Buffer.from('{"cols":80,"rows":24}');
    const bytes = encodeMessage({ messageType: 'input_stream_data', sequenceNumber: 7, flags: 1, payloadType: PayloadType.Size, payload, messageId: '11223344-5566-7788-99aa-bbccddeeff00', createdDate: 1700000000000 });
    expect(bytes.readUInt32BE(0)).toBe(116);
    expect(bytes.toString('ascii', 4, 36)).toBe('input_stream_data'.padEnd(32, ' '));
    expect(bytes.subarray(80, 112)).toEqual(createHash('sha256').update(payload).digest());
    expect(bytes.length).toBe(120 + payload.length);
    expect(decodeMessage(bytes)).toEqual({ messageType: 'input_stream_data', schemaVersion: 1, createdDate: 1700000000000, sequenceNumber: 7, flags: 1, messageId: '11223344-5566-7788-99aa-bbccddeeff00', payloadType: 3, payload });
  });

  it('stores UUIDs least-significant half first, like the agent', () => {
    const wire = uuidToWire('00112233-4455-6677-8899-aabbccddeeff');
    expect(wire.toString('hex')).toBe('8899aabbccddeeff0011223344556677');
    expect(uuidFromWire(wire)).toBe('00112233-4455-6677-8899-aabbccddeeff');
  });

  it('accepts messages padded with NULs and rejects truncated ones', () => {
    const bytes = encodeMessage({ messageType: 'acknowledge', sequenceNumber: 0, flags: 3, payloadType: 0, payload: Buffer.from('{}') });
    bytes.fill(0, 4 + 'acknowledge'.length, 36);
    expect(decodeMessage(bytes).messageType).toBe('acknowledge');
    expect(() => decodeMessage(bytes.subarray(0, 100))).toThrow(/too short/);
    const bad = Buffer.from(bytes);
    bad.writeUInt32BE(9999, 116);
    expect(() => decodeMessage(bad)).toThrow(/malformed/);
  });
});

describe('SsmSession', () => {
  it('opens with the token, sends the terminal size, and answers the session-type handshake', () => {
    const { sock } = session();
    expect(sock.binaryType).toBe('arraybuffer');
    expect(JSON.parse(sock.text[0])).toMatchObject({ MessageSchemaVersion: '1.0', TokenValue: 'TOKEN' });
    const [size] = sock.inputs();
    expect(size).toMatchObject({ sequenceNumber: 0, flags: 1, payloadType: PayloadType.Size });
    expect(JSON.parse(size.payload.toString())).toEqual({ cols: 100, rows: 30 });
    sock.output(0, JSON.stringify({ AgentVersion: '3.3', RequestedClientActions: [{ ActionType: 'SessionType', ActionParameters: { SessionType: 'InteractiveCommands' } }] }), PayloadType.HandshakeRequest);
    const response = sock.inputs().find((m) => m.payloadType === PayloadType.HandshakeResponse)!;
    expect(response.sequenceNumber).toBe(1);
    expect(JSON.parse(response.payload.toString())).toMatchObject({ ProcessedClientActions: [{ ActionType: 'SessionType', ActionStatus: 1 }], Errors: [] });
    expect(sock.acks()[0]).toMatchObject({ AcknowledgedMessageType: 'output_stream_data', AcknowledgedMessageSequenceNumber: 0, IsSequentialMessage: true });
  });

  it('delivers output in sequence order, drops duplicates and acknowledges everything', () => {
    const { sock, out } = session();
    sock.output(1, 'world');
    sock.output(0, 'hello ');
    sock.output(0, 'hello ');
    sock.output(2, '!');
    expect(out.join('')).toBe('hello world!');
    expect(sock.acks().map((a) => a.AcknowledgedMessageSequenceNumber)).toEqual([1, 0, 0, 2]);
  });

  it('decodes UTF-8 split across messages', () => {
    const { sock, out } = session();
    const euro = Buffer.from('€');
    sock.agent({ messageType: 'output_stream_data', sequenceNumber: 0, payloadType: PayloadType.Output, payload: euro.subarray(0, 1) });
    sock.agent({ messageType: 'output_stream_data', sequenceNumber: 1, payloadType: PayloadType.Output, payload: euro.subarray(1) });
    expect(out.join('')).toBe('€');
  });

  it('sends keystrokes and resizes as numbered input, and resends unacknowledged input', () => {
    vi.useFakeTimers();
    const { s, sock } = session({ resendAfterMs: 1000 });
    s.input('ls -la\r');
    s.resize(120, 40);
    s.resize(120, 40); // unchanged: not sent again
    const [, keys, size] = sock.inputs();
    expect(keys).toMatchObject({ sequenceNumber: 1, flags: 0, payloadType: PayloadType.Output });
    expect(keys.payload.toString()).toBe('ls -la\r');
    expect(JSON.parse(size.payload.toString())).toEqual({ cols: 120, rows: 40 });
    // The agent acknowledges only the size messages; the keystrokes are resent.
    for (const m of sock.inputs().filter((x) => x.payloadType === PayloadType.Size))
      sock.agent({ messageType: 'acknowledge', sequenceNumber: 0, payloadType: 0, payload: Buffer.from(JSON.stringify({ AcknowledgedMessageId: m.messageId })) });
    vi.advanceTimersByTime(1500);
    const resent = sock.inputs().filter((m) => m.messageId === keys.messageId);
    expect(resent).toHaveLength(2);
    s.close();
  });

  it('holds input while the agent pauses publication', () => {
    const { s, sock } = session();
    sock.agent({ messageType: 'pause_publication', sequenceNumber: 0, payloadType: 0, payload: Buffer.alloc(0) });
    s.input('a');
    expect(sock.inputs()).toHaveLength(1);
    sock.agent({ messageType: 'start_publication', sequenceNumber: 0, payloadType: 0, payload: Buffer.alloc(0) });
    expect(sock.inputs()).toHaveLength(2);
    s.close();
  });

  it('ends cleanly on channel_closed and refuses KMS-encrypted sessions with a clear error', () => {
    const a = session();
    a.sock.agent({ messageType: 'channel_closed', sequenceNumber: 0, payloadType: 0, payload: Buffer.from(JSON.stringify({ Output: 'Exiting session with sessionId: s-1.' })) });
    expect(a.out.join('')).toContain('Exiting session');
    expect(a.closes).toEqual([undefined]);
    expect(a.sock.closed).toBe(true);
    const b = session();
    b.sock.output(0, JSON.stringify({ RequestedClientActions: [{ ActionType: 'KMSEncryption', ActionParameters: { KMSKeyId: 'k' } }] }), PayloadType.HandshakeRequest);
    expect(b.closes[0]).toMatch(/KMS/);
  });

  it('reports a connection failure once', () => {
    const { sock, closes } = session();
    sock.onerror?.({});
    sock.onclose?.({ code: 1006 });
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatch(/ssmmessages/);
  });
});

describe('ECS Exec through AwsWorkspace', () => {
  const ACCT = '123456789012';
  const CLUSTER = `arn:aws:ecs:eu-west-2:${ACCT}:cluster/prod`;
  const TASK = `arn:aws:ecs:eu-west-2:${ACCT}:task/prod/0123456789abcdef0123456789abcdef`;
  const sender = (h: Record<string, (i: any) => any>): Sender & { calls: any[] } => {
    const calls: any[] = [];
    return { calls, send: async (c: any) => (calls.push({ name: c.constructor.name, input: c.input }), h[c.constructor.name](c.input)) };
  };

  it('calls ExecuteCommand with the app credentials and streams the shell into the terminal', async () => {
    const ecs = sender({
      DescribeTasksCommand: () => ({ tasks: [{ taskArn: TASK, clusterArn: CLUSTER, lastStatus: 'RUNNING', desiredStatus: 'RUNNING', enableExecuteCommand: true, containers: [{ name: 'app', managedAgents: [{ name: 'ExecuteCommandAgent', lastStatus: 'RUNNING' }] }] }] }),
      ExecuteCommandCommand: () => ({ session: { sessionId: 's-1', streamUrl: 'wss://ssmmessages.example/s-1', tokenValue: 'T' } }),
    });
    const sts = sender({ GetCallerIdentityCommand: () => ({ Account: ACCT, Arn: 'a' }) });
    let sock!: FakeSocket;
    const clients = (readOnly: boolean): AwsClients => ({ region: 'eu-west-2', readOnly, ecs, sts, cloudwatch: ecs, elb: ecs, ec2: ecs, logs: () => ecs });
    const w = new AwsWorkspace({ home: '/none', version: 't', emitStatus: () => undefined, emitLogs: () => undefined, findExecutable: () => null, remember: () => undefined, clients: (r) => clients(r.readOnly), socket: (url) => (sock = new FakeSocket(url)) });
    await w.connect({ mode: 'default', region: 'eu-west-2', readOnly: false });
    const out: string[] = [];
    const ch = await w.openExec(CLUSTER, TASK, 'app', 80, 24, { data: (d) => out.push(d), exit: () => undefined });
    expect(ecs.calls.find((c) => c.name === 'ExecuteCommandCommand')!.input).toEqual({ cluster: CLUSTER, task: TASK, container: 'app', interactive: true, command: '/bin/sh' });
    expect(sock.url).toBe('wss://ssmmessages.example/s-1');
    sock.open();
    sock.output(0, '# ');
    ch.write('id\r');
    expect(out.join('')).toBe('# ');
    expect(sock.inputs().at(-1)!.payload.toString()).toBe('id\r');
    ch.kill();
    expect(sock.closed).toBe(true);

    await w.connect({ mode: 'default', region: 'eu-west-2', readOnly: true });
    await expect(w.openExec(CLUSTER, TASK, 'app', 80, 24, { data: () => undefined, exit: () => undefined })).rejects.toThrow(/read-only/);
  });
});
