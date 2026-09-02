import http from "node:http";
import type { AddressInfo } from "node:net";

export interface MockRequest {
  method: string;
  url: URL;
  pathname: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  bodyBuf: Buffer;
  json: () => unknown;
}

export type MockHandler = (req: MockRequest, res: http.ServerResponse) => void | Promise<void>;

export interface MockServer {
  url: string;
  origin: string;
  close: () => Promise<void>;
}

export function json(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...extraHeaders,
  });
  res.end(payload);
}

export async function startMockServer(handler: MockHandler): Promise<MockServer> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const bodyBuf = Buffer.concat(chunks);
      const body = bodyBuf.toString("utf8");
      const host = req.headers.host ?? "127.0.0.1";
      const url = new URL(req.url ?? "/", `http://${host}`);
      const wrapped: MockRequest = {
        method: req.method ?? "GET",
        url,
        pathname: url.pathname,
        headers: req.headers,
        body,
        bodyBuf,
        json: () => (body ? JSON.parse(body) : null),
      };
      Promise.resolve(handler(wrapped, res)).catch((err: unknown) => {
        if (!res.headersSent) {
          json(res, 500, { error: { message: String(err) } });
        }
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${addr.port}`;
  return {
    url: origin,
    origin,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
