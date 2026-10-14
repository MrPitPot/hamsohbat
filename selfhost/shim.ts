// Stand-ins for the Cloudflare runtime APIs the Hub uses, so the same code runs on plain Node.
export class DurableObject<E = any> {
  ctx: any;
  env: E;
  constructor(ctx: any, env: E) {
    this.ctx = ctx;
    this.env = env;
  }
}

(globalThis as any).WebSocketRequestResponsePair = class {
  constructor(public request: string, public response: string) {}
};
