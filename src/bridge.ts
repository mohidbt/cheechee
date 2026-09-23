import { ServerMessageSchema, type AudioEngine, type AudioTrack, type BatchResult, type Command, type CommandResult, type ServerMessage } from '../shared/contracts';

export type BridgeEvent =
  | { type: 'connection'; connected: boolean }
  | { type: 'busy'; busy: boolean }
  | { type: 'tool'; requestId: string; batchId: string; index: number; command: Command; status: 'requested' | 'scheduled' | 'completed' | 'failed'; result?: CommandResult }
  | { type: 'assistant'; text: string; acknowledged: boolean }
  | { type: 'error'; text: string };

export class DJBridge {
  private socket?: WebSocket;
  private retry?: ReturnType<typeof setTimeout>;
  private requestId?: string;
  private generation = 0;
  private seenBatches = new Set<string>();
  private applied = false;
  private closed = false;

  constructor(private engine: AudioEngine, private tracks: () => AudioTrack[], private onEvent: (event: BridgeEvent) => void) {}

  connect() {
    if (this.closed || this.socket && (this.socket.readyState === WebSocket.CONNECTING || this.socket.readyState === WebSocket.OPEN)) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}/ws`);
    this.socket = socket;
    socket.onopen = () => { this.seenBatches.clear(); this.onEvent({ type: 'connection', connected: true }); };
    socket.onmessage = event => {
      let data: ServerMessage;
      try { data = ServerMessageSchema.parse(JSON.parse(event.data)); }
      catch { this.onEvent({ type: 'error', text: 'The agent sent an invalid response.' }); return; }
      void this.receive(data);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.generation++;
      if (this.requestId) this.onEvent({ type: 'error', text: 'Agent connection lost. Check the console before retrying an unfinished action.' });
      this.requestId = undefined;
      this.onEvent({ type: 'busy', busy: false });
      this.onEvent({ type: 'connection', connected: false });
      if (!this.closed) this.retry = setTimeout(() => this.connect(), 1500);
    };
    socket.onerror = () => { /* onclose reports the connection state */ };
  }

  submit(text: string): boolean {
    if (this.requestId || this.socket?.readyState !== WebSocket.OPEN || !text.trim()) return false;
    const requestId = crypto.randomUUID();
    this.requestId = requestId;
    this.applied = false;
    this.onEvent({ type: 'busy', busy: true });
    this.socket.send(JSON.stringify({
      type: 'request', requestId, text: text.trim(), state: this.engine.getState(),
      tracks: this.tracks().map(({ url: _url, ...track }) => track),
    }));
    return true;
  }

  cancel() {
    this.generation++;
    if (this.requestId && this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'cancel', requestId: this.requestId }));
    this.requestId = undefined;
    this.applied = false;
    this.onEvent({ type: 'busy', busy: false });
  }

  close() {
    this.closed = true;
    clearTimeout(this.retry);
    this.cancel();
    this.socket?.close();
  }

  private async receive(message: ServerMessage) {
    if (message.type === 'agent_status') {
      if (message.requestId === this.requestId && message.status === 'idle') {
        this.requestId = undefined;
        this.onEvent({ type: 'busy', busy: false });
      }
      return;
    }
    if (message.requestId !== this.requestId) return;
    if (message.type === 'error') {
      this.onEvent({ type: 'error', text: message.message });
      this.requestId = undefined;
      this.onEvent({ type: 'busy', busy: false });
      return;
    }
    if (message.type === 'assistant_message') {
      this.onEvent({ type: 'assistant', text: message.text, acknowledged: this.applied });
      return;
    }
    if (this.seenBatches.has(message.batchId)) return;
    this.seenBatches.add(message.batchId);
    const generation = this.generation;
    const results: CommandResult[] = [];
    for (const [index, command] of message.commands.entries()) {
      if (generation !== this.generation || message.requestId !== this.requestId) return;
      this.onEvent({ type: 'tool', requestId: message.requestId, batchId: message.batchId, index, command, status: 'requested' });
      let result: CommandResult;
      try { result = await this.engine.execute(command); }
      catch (error) { result = { ok: false, code: 'execution_error', message: error instanceof Error ? error.message : 'DJ action failed.' }; }
      if (generation !== this.generation || message.requestId !== this.requestId) return;
      results.push(result);
      this.onEvent({ type: 'tool', requestId: message.requestId, batchId: message.batchId, index, command, status: result.ok ? result.scheduled ? 'scheduled' : 'completed' : 'failed', result });
      if (!result.ok) {
        for (let skipped = index + 1; skipped < message.commands.length; skipped++) {
          const next = message.commands[skipped];
          const skip: CommandResult = { ok: false, code: 'skipped', message: 'Skipped after an earlier command failed.' };
          results.push(skip);
          this.onEvent({ type: 'tool', requestId: message.requestId, batchId: message.batchId, index: skipped, command: next, status: 'failed', result: skip });
        }
        break;
      }
    }
    const failed = results.find(result => !result.ok && result.code !== 'skipped');
    const summary = failed ? `${failed.message}${results.some(result => result.ok) ? ' Earlier commands were applied.' : ''}` : results.map(result => result.message).join(' ');
    const result: BatchResult = { ok: !failed, message: summary, results, state: this.engine.getState() };
    this.applied = true;
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'tool_result', requestId: message.requestId, batchId: message.batchId, result }));
  }
}
