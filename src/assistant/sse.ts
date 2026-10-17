// Server-sent events, as both providers stream responses: "event:" and "data:" lines, with a
// blank line ending each event. https://html.spec.whatwg.org/multipage/server-sent-events.html

export interface ServerEvent {
  event: string;
  data: string;
}

/** Splits a byte stream into events. */
export async function* readEvents(
  body: AsyncIterable<Uint8Array>,
): AsyncGenerator<ServerEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  let event = '';
  let data: string[] = [];

  function* flushLine(line: string): Generator<ServerEvent> {
    if (line === '') {
      if (data.length)
        yield { event: event || 'message', data: data.join('\n') };
      event = '';
      data = [];
    } else if (!line.startsWith(':')) {
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
  }

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.search(/\r\n|\r|\n/)) !== -1) {
      // A "\r" at the end may be the first half of "\r\n": wait for the next chunk.
      if (newline === buffer.length - 1 && buffer.endsWith('\r')) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(
        newline + (buffer.startsWith('\r\n', newline) ? 2 : 1),
      );
      yield* flushLine(line);
    }
  }
  buffer += decoder.decode();
  if (buffer) yield* flushLine(buffer);
  yield* flushLine('');
}
