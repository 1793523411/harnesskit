import type { ConsumeStreamOpts } from '../types.js';
import type { BedrockResponse } from './types.js';

/**
 * Bedrock Converse streaming uses the AWS Event Stream binary framing
 * (`application/vnd.amazon.eventstream`) — total length / headers length /
 * prelude CRC / headers / payload / message CRC, payload-as-JSON-with-base64.
 *
 * That's a separate parser from anything else we have today and it's deferred
 * to a follow-up. For now we drain the body and return an errored result so
 * the caller gets a clear "not yet implemented" signal instead of binary
 * garbage flowing into normalizeResponse.
 *
 * Non-streaming Converse (POST `/converse`) works fully — only `/converse-stream`
 * needs this stub.
 */
export const consumeBedrockStream = async (
  stream: ReadableStream<Uint8Array>,
  _opts?: ConsumeStreamOpts,
): Promise<{
  response: BedrockResponse;
  errored: Error | undefined;
  eagerlyEmittedCallIds?: string[];
  aborted?: boolean;
}> => {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  } catch {
    // Drain failures are not the interesting error here.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const empty: BedrockResponse = {
    output: { message: { role: 'assistant', content: [] } },
  };
  return {
    response: empty,
    errored: new Error(
      'Bedrock /converse-stream uses AWS Event Stream binary framing which is not yet parsed by harnesskit; turn.start was still emitted, but turn.end content will be empty. Use /converse (non-streaming) for now.',
    ),
  };
};
