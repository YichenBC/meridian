import readline from 'readline';
import { Channel, OnInboundMessage, UserMessage } from '../types.js';
import crypto from 'crypto';

export class CliChannel implements Channel {
  name = 'cli';
  private rl: readline.Interface | null = null;
  private connected = false;
  private onMessage: OnInboundMessage;

  constructor(onMessage: OnInboundMessage) {
    this.onMessage = onMessage;
  }

  async connect(): Promise<void> {
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    this.connected = true;
    this.rl.setPrompt('you> ');
    this.rl.prompt();

    this.rl.on('line', (line) => {
      const content = line.trim();
      if (!content) { this.rl?.prompt(); return; }

      const msg: UserMessage = {
        id: crypto.randomUUID(),
        channelId: 'cli:0',
        sender: 'user',
        content,
        timestamp: new Date().toISOString(),
      };
      this.onMessage(msg);
    });

    this.rl.on('close', () => { this.connected = false; });
  }

  async sendMessage(text: string, targetChannelId?: string): Promise<void> {
    if (targetChannelId && targetChannelId !== 'cli:0') return;
    console.log(`\x1b[36mmeridian>\x1b[0m ${text}`);
    this.rl?.prompt();
  }

  isConnected(): boolean { return this.connected; }

  async disconnect(): Promise<void> {
    this.rl?.close();
    this.connected = false;
  }
}
