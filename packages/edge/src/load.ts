// Loads handler.js the way CloudFront runs it: as a plain script in a fresh
// context with no Node globals (no require, process or Buffer), so tests and
// the local proxy exercise exactly the code that ships.
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

export const handlerSource = () => readFileSync(new URL('./handler.js', import.meta.url), 'utf8');

export function loadHandler(): Handle {
  const context = vm.createContext({});
  vm.runInContext(`${handlerSource()}\n;globalThis.handle = handle;`, context, { filename: 'handler.js' });
  return context.handle as Handle;
}

export const isResponse = (result: EdgeRequest | EdgeResponse): result is EdgeResponse => 'statusCode' in result;
