import type { AgentIds } from '@harnesskit/core';

export class SessionState<T> {
  private map = new Map<string, T>();

  get(ids: AgentIds, init: () => T): T {
    const key = ids.sessionId;
    let v = this.map.get(key);
    if (!v) {
      v = init();
      this.map.set(key, v);
    }
    return v;
  }

  peek(sessionId: string): T | undefined {
    return this.map.get(sessionId);
  }

  reset(sessionId: string): void {
    this.map.delete(sessionId);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
