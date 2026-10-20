// A built-in client for AWS Systems Manager Session Manager data channels, as used by ECS Exec.
// It replaces the aws CLI + session-manager-plugin: ECS ExecuteCommand returns a stream URL and token,
// and this speaks the agent's binary message protocol over a WebSocket.
import { createHash, randomUUID } from 'node:crypto';

export const PayloadType = {
  Output: 1,
  Error: 2,
  Size: 3,
  Parameter: 4,
  HandshakeRequest: 5,
  HandshakeResponse: 6,
  HandshakeComplete: 7,
  EncChallengeRequest: 8,
  EncChallengeResponse: 9,
  Flag: 10,
  StdErr: 11,
  ExitCode: 12,
} as const;

const HEADER_LENGTH = 116; // bytes after the 4-byte header-length field, up to (not including) the payload-length field
const PAYLOAD_OFFSET = 120;
const CLIENT_VERSION = '1.2.0.0';

export interface AgentMessage {
  messageType: string;
  schemaVersion: number;
  createdDate: number;
  sequenceNumber: number;
  flags: number;
  messageId: string;
  payloadType: number;
  payload: Buffer;
}

/** The agent stores a UUID as its least-significant 8 bytes followed by its most-significant 8 bytes. */
export function uuidToWire(uuid: string): Buffer {
  const b = Buffer.from(uuid.replace(/-/g, ''), 'hex');
  if (b.length !== 16) throw new Error(`invalid UUID ${uuid}`);
  return Buffer.concat([b.subarray(8, 16), b.subarray(0, 8)]);
}

export function uuidFromWire(b: Buffer): string {
  const h = Buffer.concat([b.subarray(8, 16), b.subarray(0, 8)]).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function encodeMessage(m: Omit<AgentMessage, 'schemaVersion' | 'createdDate' | 'messageId'> & Partial<Pick<AgentMessage, 'schemaVersion' | 'createdDate' | 'messageId'>>): Buffer {
  const buf = Buffer.alloc(PAYLOAD_OFFSET + m.payload.length);
  buf.writeUInt32BE(HEADER_LENGTH, 0);
  // Message type: 32 bytes, padded with spaces like the official plugin.
  buf.fill(0x20, 4, 36);
  buf.write(m.messageType.slice(0, 32), 4, 'ascii');
  buf.writeUInt32BE(m.schemaVersion ?? 1, 36);
  buf.writeBigUInt64BE(BigInt(m.createdDate ?? Date.now()), 40);
  buf.writeBigInt64BE(BigInt(m.sequenceNumber), 48);
  buf.writeBigUInt64BE(BigInt(m.flags), 56);
  uuidToWire(m.messageId ?? randomUUID()).copy(buf, 64);
  createHash('sha256').update(m.payload).digest().copy(buf, 80);
  buf.writeUInt32BE(m.payloadType, 112);
  buf.writeUInt32BE(m.payload.length, 116);
  m.payload.copy(buf, PAYLOAD_OFFSET);
  return buf;
}

export function decodeMessage(data: Buffer): AgentMessage {
  if (data.length < PAYLOAD_OFFSET) throw new Error(`agent message too short (${data.length} bytes)`);
  const headerLength = data.readUInt32BE(0);
  const payloadLength = data.readUInt32BE(116);
  const start = headerLength + 4;
  if (start < PAYLOAD_OFFSET || start + payloadLength > data.length) throw new Error('malformed agent message');
  return {
    messageType: data.toString('ascii', 4, 36).replace(/[\s\0]+$/g, '').replace(/^[\s\0]+/g, ''),
    schemaVersion: data.readUInt32BE(36),
    createdDate: Number(data.readBigUInt64BE(40)),
    sequenceNumber: Number(data.readBigInt64BE(48)),
    flags: Number(data.readBigUInt64BE(56)),
    messageId: uuidFromWire(data.subarray(64, 80)),
    payloadType: data.readUInt32BE(112),
    payload: data.subarray(start, start + payloadLength),
  };
}

/** The subset of the WebSocket API this client needs (the global WebSocket in Node 22+ / Electron provides it). */
export interface SocketLike {
  binaryType: string;
  readyState: number;
  send(data: string | ArrayBufferLike | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface SsmSessionOptions {
  streamUrl: string;
  token: string;
  cols: number;
  rows: number;
  onData: (data: string) => void;
  /** Called once when the session ends; `error` is set when it ended because of a failure. */
  onClose: (error?: string) => void;
  socket?: (url: string) => SocketLike;
  /** Resend unacknowledged input after this long (ms). */
  resendAfterMs?: number;
}

interface Outgoing {
  bytes: Buffer;
  sentAt: number;
  attempts: number;
}

export class SsmSession {
  private ws: SocketLike | null = null;
  private outSeq = 0;
  private expectedSeq = 0;
  private readonly early = new Map<number, AgentMessage>();
  private readonly unacked = new Map<string, Outgoing>();
  private readonly queued: Buffer[] = [];
  private paused = false;
  private closed = false;
  private timer: NodeJS.Timeout | null = null;
  private cols: number;
  private rows: number;
  private readonly decoder = new TextDecoder('utf-8');

  constructor(private readonly o: SsmSessionOptions) {
    this.cols = o.cols;
    this.rows = o.rows;
  }

  start(): this {
    const ws = this.o.socket ? this.o.socket(this.o.streamUrl) : (new WebSocket(this.o.streamUrl) as unknown as SocketLike);
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      ws.send(JSON.stringify({ MessageSchemaVersion: '1.0', RequestId: randomUUID(), TokenValue: this.o.token, ClientId: randomUUID(), ClientVersion: CLIENT_VERSION }));
      this.sendSize();
    };
    ws.onmessage = (ev) => {
      try {
        const data = ev.data;
        if (typeof data === 'string') return; // the agent only sends binary frames after the token
        this.handle(decodeMessage(Buffer.from(data as ArrayBuffer)));
      } catch (err) {
        this.finish(`Session protocol error: ${(err as Error).message}`);
      }
    };
    ws.onerror = () => this.finish('Could not connect to the Session Manager endpoint (ssmmessages). Check network access to AWS.');
    ws.onclose = (ev) => this.finish(ev.code && ev.code !== 1000 && ev.code !== 1005 ? `Session closed (${ev.code}${ev.reason ? `: ${ev.reason}` : ''})` : undefined);
    this.timer = setInterval(() => this.resend(), Math.max(200, this.o.resendAfterMs ?? 3000));
    return this;
  }

  input(data: string): void {
    if (data) this.sendStream(PayloadType.Output, Buffer.from(data, 'utf8'));
  }

  resize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.sendSize();
  }

  close(): void {
    this.finish();
  }

  private sendSize(): void {
    this.sendStream(PayloadType.Size, Buffer.from(JSON.stringify({ cols: this.cols, rows: this.rows })));
  }

  private sendStream(payloadType: number, payload: Buffer): void {
    if (this.closed) return;
    const messageId = randomUUID();
    const bytes = encodeMessage({ messageType: 'input_stream_data', sequenceNumber: this.outSeq, flags: this.outSeq === 0 ? 1 : 0, messageId, payloadType, payload });
    this.outSeq++;
    this.unacked.set(messageId, { bytes, sentAt: Date.now(), attempts: 1 });
    if (this.paused || !this.ws || this.ws.readyState !== 1) this.queued.push(bytes);
    else this.ws.send(bytes);
  }

  private sendRaw(bytes: Buffer): void {
    if (this.ws && this.ws.readyState === 1) this.ws.send(bytes);
  }

  private ack(m: AgentMessage): void {
    const payload = Buffer.from(JSON.stringify({ AcknowledgedMessageType: m.messageType, AcknowledgedMessageId: m.messageId, AcknowledgedMessageSequenceNumber: m.sequenceNumber, IsSequentialMessage: true }));
    this.sendRaw(encodeMessage({ messageType: 'acknowledge', sequenceNumber: 0, flags: 3, payloadType: 0, payload }));
  }

  private handle(m: AgentMessage): void {
    switch (m.messageType) {
      case 'output_stream_data': {
        this.ack(m);
        if (m.sequenceNumber < this.expectedSeq) return; // a resend we already processed
        this.early.set(m.sequenceNumber, m);
        for (let next = this.early.get(this.expectedSeq); next; next = this.early.get(this.expectedSeq)) {
          this.early.delete(this.expectedSeq);
          this.expectedSeq++;
          this.process(next);
        }
        return;
      }
      case 'acknowledge': {
        try {
          const a = JSON.parse(m.payload.toString('utf8'));
          this.unacked.delete(String(a.AcknowledgedMessageId));
        } catch {
          // ignore malformed acknowledgements; the message is resent
        }
        return;
      }
      case 'pause_publication':
        this.paused = true;
        return;
      case 'start_publication':
        this.paused = false;
        for (const b of this.queued.splice(0)) this.sendRaw(b);
        return;
      case 'channel_closed': {
        let msg: string | undefined;
        try {
          const p = JSON.parse(m.payload.toString('utf8'));
          msg = p.Output || undefined;
        } catch {
          // no details
        }
        if (msg) this.o.onData(`\r\n${msg}\r\n`);
        this.finish();
        return;
      }
    }
  }

  private process(m: AgentMessage): void {
    switch (m.payloadType) {
      case PayloadType.Output:
      case PayloadType.StdErr:
      case PayloadType.Error:
        this.o.onData(this.decoder.decode(m.payload, { stream: true }));
        return;
      case PayloadType.HandshakeRequest: {
        let req: any;
        try {
          req = JSON.parse(m.payload.toString('utf8'));
        } catch {
          return this.finish('Session handshake failed: malformed request');
        }
        const actions: any[] = Array.isArray(req.RequestedClientActions) ? req.RequestedClientActions : [];
        if (actions.some((a) => a.ActionType === 'KMSEncryption')) {
          return this.finish('This cluster encrypts ECS Exec sessions with a KMS key, which the built-in shell does not support yet. Use `aws ecs execute-command` with the Session Manager plugin for this cluster.');
        }
        const response = {
          ClientVersion: CLIENT_VERSION,
          ProcessedClientActions: actions.map((a) => ({ ActionType: a.ActionType, ActionStatus: 1 })),
          Errors: [],
        };
        this.sendStream(PayloadType.HandshakeResponse, Buffer.from(JSON.stringify(response)));
        return;
      }
      case PayloadType.EncChallengeRequest:
        return this.finish('This session requires KMS encryption, which the built-in shell does not support yet.');
      case PayloadType.HandshakeComplete:
        try {
          const done = JSON.parse(m.payload.toString('utf8'));
          if (done.CustomerMessage) this.o.onData(`${done.CustomerMessage}\r\n`);
        } catch {
          // nothing to show
        }
        return;
      default:
        return; // Flag, ExitCode, Parameter: nothing to render
    }
  }

  private resend(): void {
    const now = Date.now();
    const after = this.o.resendAfterMs ?? 3000;
    for (const [id, out] of this.unacked) {
      if (now - out.sentAt < after || this.paused) continue;
      if (out.attempts >= 10) {
        this.unacked.delete(id);
        continue;
      }
      out.sentAt = now;
      out.attempts++;
      this.sendRaw(out.bytes);
    }
  }

  private finish(error?: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try {
        ws.close(1000);
      } catch {
        // already closed
      }
    }
    this.o.onClose(error);
  }
}
