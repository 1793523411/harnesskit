import type { AgentEvent } from './events.js';
import { isGateable } from './events.js';
import type { DenyDecision, Interceptor, InterceptorContext } from './interceptor.js';

export interface DispatchResult {
  denied?: DenyDecision;
}

export interface EventBusOptions {
  /**
   * If an interceptor throws, the bus emits an `error` event and continues
   * unless `failFast` is true.
   */
  failFast?: boolean;

  /** Optional sink for events that escape interceptor handling. */
  onUnhandledError?: (err: unknown, event: AgentEvent) => void;
}

export class EventBus {
  private interceptors: Interceptor[] = [];
  private initialized = false;
  private disposed = false;
  private readonly opts: EventBusOptions;

  constructor(opts: EventBusOptions = {}) {
    this.opts = opts;
  }

  use(interceptor: Interceptor): this {
    if (this.disposed) throw new Error('EventBus is disposed');
    this.interceptors.push(interceptor);
    return this;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    for (const i of this.interceptors) {
      await i.init?.();
    }
  }

  async emit(event: AgentEvent, signal?: AbortSignal): Promise<DispatchResult> {
    if (this.disposed) return {};
    if (!this.initialized) await this.init();

    let denied: DenyDecision | undefined;
    const localCtl = new AbortController();
    const linkedSignal = signal ? AbortSignal.any([signal, localCtl.signal]) : localCtl.signal;

    const ctx: InterceptorContext = {
      emit: async (e) => {
        await this.emit(e, linkedSignal);
      },
      deny: (reason, policyId) => {
        if (!isGateable(event)) {
          // Soft warning — keeps the SDK debuggable without throwing.
          // Consumers can lift this into an error event via failFast.
          console.warn(
            `[harnesskit] deny() called on non-gateable event "${event.type}" — ignored`,
          );
          return;
        }
        if (!denied) denied = { reason, ...(policyId ? { policyId } : {}) };
      },
      signal: linkedSignal,
    };

    for (const i of this.interceptors) {
      if (linkedSignal.aborted) break;
      try {
        await i.on(event, ctx);
      } catch (err) {
        if (this.opts.failFast) throw err;
        this.opts.onUnhandledError?.(err, event);
      }
    }

    return denied ? { denied } : {};
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const i of this.interceptors) {
      try {
        await i.dispose?.();
      } catch (err) {
        this.opts.onUnhandledError?.(err, {
          type: 'error',
          ts: Date.now(),
          ids: { sessionId: 'dispose', turnId: 'dispose' },
          source: 'l1',
          message: err instanceof Error ? err.message : String(err),
          stage: 'interceptor',
          cause: err,
        });
      }
    }
    this.interceptors = [];
  }
}
