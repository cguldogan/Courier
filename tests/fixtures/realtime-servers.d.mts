import type { IncomingHttpHeaders } from 'node:http'

export const PROTO_ROOT: string
export const ECHO_PROTO: string

export interface WsTestServer {
  url: string
  port: number
  handshakes: { path: string; query: Record<string, string>; headers: IncomingHttpHeaders }[]
  received: { path: string; binary: boolean; data: Buffer }[]
  clients(): number
  stop(): Promise<void>
}
export function startWsServer(opts?: { tls?: { cert: Buffer; key: Buffer } }): Promise<WsTestServer>

export interface GrpcTestServer {
  address: string
  port: number
  calls: { name: string; metadata: Record<string, string | Buffer> }[]
  stop(): Promise<void>
}
export function startGrpcServer(opts?: { tls?: { cert: Buffer; key: Buffer }; reflection?: 'both' | 'v1alpha' | 'none' }): Promise<GrpcTestServer>
