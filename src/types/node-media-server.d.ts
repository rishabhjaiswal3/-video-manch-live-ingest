declare module 'node-media-server' {
  interface NodeMediaServerSession {
    reject(): void;
  }

  type NodeMediaServerEventHandler = (
    id: string,
    streamPath: string,
    args: Record<string, string>
  ) => void | Promise<void>;

  export default class NodeMediaServer {
    constructor(config?: unknown);
    run(): void;
    stop(): void;
    on(event: string, handler: NodeMediaServerEventHandler): void;
    getSession(id: string): NodeMediaServerSession | undefined;
  }
}
