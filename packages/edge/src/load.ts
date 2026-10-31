// Loads handler.js and response.js the way CloudFront runs them: as plain
// scripts in a fresh context with no Node globals (no require, process or
// Buffer), so tests and the local proxy exercise exactly the code that ships.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export type Header = { value: string };
export type EdgeRequest = {
  method: string;
  uri: string;
  querystring: Record<string, Header>;
  headers: Record<string, Header>;
  cookies: Record<string, Header>;
};
export type EdgeResponse = {
  statusCode: number;
  statusDescription: string;
  headers: Record<string, Header>;
  cookies?: Record<string, { value: string; attributes: string }>;
  body?: { encoding: 'text'; data: string };
};
export type EdgeOptions = {
  kvs: { get(key: string): Promise<string> };
  crypto: { createHmac(algorithm: string, key: string): { update(data: string): { digest(encoding: 'hex'): string } } };
  now: number;
  sites: string; // the site domain: hosts are <site-id or name>.<sites>
  auth: string; // the auth. origin, e.g. https://auth.example.com
  scheme?: 'http' | 'https'; // for redirects between site hosts; https unless local
};
export type Handle = (event: { request: EdgeRequest }, options: EdgeOptions) => Promise<EdgeRequest | EdgeResponse>;

// The viewer-response event: the viewer's request and the response to it.
export type ResponseEvent = { request: { headers: Record<string, Header> }; response: { statusCode: number; headers: Record<string, Header> } };
export type Robots = (event: ResponseEvent, options: { sites: string }) => ResponseEvent['response'];

export const handlerSource = () => readFileSync(new URL('./handler.js', import.meta.url), 'utf8');
export const responseSource = () => readFileSync(new URL('./response.js', import.meta.url), 'utf8');

function load<T>(source: string, name: string, filename: string): T {
  const context = vm.createContext({});
  vm.runInContext(`${source}\n;globalThis.${name} = ${name};`, context, { filename });
  return context[name] as T;
}

export const loadHandler = (): Handle => load<Handle>(handlerSource(), 'handle', 'handler.js');
export const loadRobots = (): Robots => load<Robots>(responseSource(), 'robots', 'response.js');

export const isResponse = (result: EdgeRequest | EdgeResponse): result is EdgeResponse => 'statusCode' in result;
