// A small MCP client: JSON-RPC tool calls over HTTP with a bearer token, which
// is all the CLI needs (decision 3). The server is stateless, so each call
// stands alone. Answers come as JSON or as an event stream with one message.
import { accessToken } from './auth.ts';
import { type Reply, request } from './http.ts';

// The server refused the call: its message is meant to be shown as it is.
export class ToolRefused extends Error {}

export type CallOptions = { dir?: string };

let nextId = 1;

function message(reply: Reply): Record<string, unknown> {
  const text = reply.body.toString('utf8');
  const type = String(reply.headers['content-type'] ?? '');
  const data = type.includes('text/event-stream')
    ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).at(-1) ?? '{}'
    : text;
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    throw new Error(`The server sent something that isn't JSON (HTTP ${reply.status}).`);
  }
}

// Calls a tool and returns its result, parsed from the text it returns.
export async function callTool<T = Record<string, unknown>>(server: string, name: string, args: Record<string, unknown>, options: CallOptions = {}): Promise<T> {
  const send = async (token: string) => request(server, {
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  let reply = await send(await accessToken(server, options));
  // A token the server no longer accepts: refresh once and retry.
  if (reply.status === 401) reply = await send(await accessToken(server, { ...options, force: true }));
  if (reply.status === 401) throw new Error(`${server} didn't accept the sign-in. Run: passa login ${server}`);
  if (reply.status === 429) throw new Error('Too many requests to Passa right now. Wait a moment and try again.');
  if (reply.status >= 400) throw new Error(`${server} answered HTTP ${reply.status}.`);
  const msg = message(reply);
  if (msg.error) throw new Error(`The server refused the request: ${String((msg.error as { message?: unknown }).message ?? 'unknown error')}`);
  const result = msg.result as { isError?: boolean; content?: { type: string; text?: string }[] } | undefined;
  const text = result?.content?.find((c) => c.type === 'text')?.text ?? '';
  if (result?.isError) throw new ToolRefused(text);
  try {
    return JSON.parse(text) as T;
  } catch {
    return { text } as T;
  }
}
