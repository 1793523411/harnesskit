export interface SseEvent {
  event?: string;
  data: string;
}

const splitLines = (): TransformStream<string, string> => {
  let buffer = '';
  return new TransformStream<string, string>({
    transform(chunk, controller) {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) controller.enqueue(line);
    },
    flush(controller) {
      if (buffer) controller.enqueue(buffer);
    },
  });
};

const parseEvents = (): TransformStream<string, SseEvent> => {
  let event: string | undefined;
  let data = '';
  const flush = (controller: TransformStreamDefaultController<SseEvent>) => {
    if (data) {
      const out: SseEvent = { data };
      if (event !== undefined) out.event = event;
      controller.enqueue(out);
    }
    event = undefined;
    data = '';
  };
  return new TransformStream<string, SseEvent>({
    transform(line, controller) {
      const trimmed = line.replace(/\r$/, '');
      if (trimmed === '') {
        flush(controller);
        return;
      }
      if (trimmed.startsWith(':')) return;
      const idx = trimmed.indexOf(':');
      const field = idx === -1 ? trimmed : trimmed.slice(0, idx);
      const valueRaw = idx === -1 ? '' : trimmed.slice(idx + 1);
      const value = valueRaw.startsWith(' ') ? valueRaw.slice(1) : valueRaw;
      if (field === 'event') event = value;
      else if (field === 'data') data = data ? `${data}\n${value}` : value;
    },
    flush(controller) {
      flush(controller);
    },
  });
};

const decodeBytes = (): TransformStream<Uint8Array, string> => {
  const decoder = new TextDecoder();
  return new TransformStream<Uint8Array, string>({
    transform(chunk, controller) {
      controller.enqueue(decoder.decode(chunk, { stream: true }));
    },
    flush(controller) {
      const tail = decoder.decode();
      if (tail) controller.enqueue(tail);
    },
  });
};

export const parseSseStream = (stream: ReadableStream<Uint8Array>): ReadableStream<SseEvent> =>
  stream.pipeThrough(decodeBytes()).pipeThrough(splitLines()).pipeThrough(parseEvents());
