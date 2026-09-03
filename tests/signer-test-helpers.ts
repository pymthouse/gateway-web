import type { ServerResponse } from "node:http";
import {
  clearSignerInfoCache,
  LivePaymentSession,
  type LivePaymentSessionOptions,
} from "../src/signer.js";
import type { LivePaymentChallenge } from "../src/types.js";
import { json, startMockServer, type MockHandler, type MockRequest } from "./mock-server.js";

export const MOCK_SIGNER = { address: "0xabc", signature: "0xsig" } as const;

const DEFAULT_PAYMENT_STATE: Record<string, unknown> = { n: 1 };

export function replySignOrchestratorInfo(req: MockRequest, res: ServerResponse): boolean {
  if (req.pathname === "/sign-orchestrator-info") {
    json(res, 200, MOCK_SIGNER);
    return true;
  }
  return false;
}

export function replySignerPayment(
  req: MockRequest,
  res: ServerResponse,
  paymentState: Record<string, unknown> = DEFAULT_PAYMENT_STATE,
): boolean {
  if (replySignOrchestratorInfo(req, res)) return true;
  if (req.pathname === "/generate-live-payment") {
    json(res, 200, { payment: "PAY", segCreds: "SEG", state: paymentState });
    return true;
  }
  return false;
}

export function fixedChallenge(origin: string): LivePaymentChallenge {
  return {
    paymentParams: "params-1",
    manifestId: "man-1",
    paymentUrl: `${origin}/pay`,
  };
}

export function shortChallenge(origin: string): LivePaymentChallenge {
  return {
    paymentParams: "p",
    manifestId: "m",
    paymentUrl: `${origin}/pay`,
  };
}

export async function withCapturedMints(
  extra: Partial<LivePaymentSessionOptions>,
  run: (
    session: LivePaymentSession,
    bodies: Array<Record<string, unknown>>,
    origin: string,
  ) => Promise<void>,
): Promise<void> {
  const bodies: Array<Record<string, unknown>> = [];
  const server = await startMockServer((req, res) => {
    if (req.pathname === "/generate-live-payment") {
      bodies.push(req.json() as Record<string, unknown>);
      json(res, 200, { payment: "pay-1", segCreds: "seg-1", state: { n: 1 } });
      return;
    }
    json(res, 404, { error: { message: req.pathname } });
  });
  try {
    clearSignerInfoCache();
    const session = new LivePaymentSession({
      signerUrl: server.origin,
      type: "fixed",
      challenge: fixedChallenge(server.origin),
      ...extra,
    });
    await run(session, bodies, server.origin);
  } finally {
    clearSignerInfoCache();
    await server.close();
  }
}

export async function withLivePaymentSession(
  handler: MockHandler,
  buildOptions: (origin: string) => Omit<LivePaymentSessionOptions, "signerUrl">,
  run: (session: LivePaymentSession) => Promise<void>,
): Promise<void> {
  const server = await startMockServer(handler);
  try {
    const session = new LivePaymentSession({
      signerUrl: server.origin,
      ...buildOptions(server.origin),
    });
    await run(session);
  } finally {
    await server.close();
  }
}
