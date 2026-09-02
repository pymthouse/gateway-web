import { LivepeerGatewayError } from "./errors.js";
import { joinEndpoint } from "./http.js";
import {
  callSession,
  reserveSession,
  stopSession,
  type CallSessionOptions,
  type ReserveSessionOptions,
  type RunnerSession,
  type StopSessionOptions,
} from "./session.js";
import { LivePaymentSession, type PaymentSessionSnapshot } from "./signer.js";
import { channelUrl, parseTrickleChannels, type TrickleChannel } from "./trickle/channels.js";
import type { HeadersMap, LiveRunnerInstance } from "./types.js";

export interface StreamSessionSnapshot {
  sessionId: string;
  appUrl: string;
  runnerUrl: string;
  controlUrl: string;
  runner: LiveRunnerInstance;
  endpoint: string;
  channels: Record<string, TrickleChannel>;
  payment: PaymentSessionSnapshot | null;
}

export interface OpenStreamSessionOptions extends ReserveSessionOptions {
  /** App path that opens trickle channels (`/echo`, `/stream`, …). */
  endpoint: string;
  streamPayload?: Record<string, unknown>;
  callTimeoutMs?: number;
}

export interface StreamSession {
  session: RunnerSession;
  endpoint: string;
  channels: Map<string, TrickleChannel>;
  snapshot(): StreamSessionSnapshot;
  channelUrl(name: string): string;
  call(options: CallSessionOptions): ReturnType<typeof callSession>;
  stop(options?: StopSessionOptions): Promise<void>;
}

export interface ResumeStreamSessionOptions {
  snapshot: StreamSessionSnapshot;
  signerUrl: string | null;
  signerHeaders?: HeadersMap;
  startFunding?: boolean;
}

function channelsRecord(channels: Map<string, TrickleChannel>): Record<string, TrickleChannel> {
  const rec: Record<string, TrickleChannel> = {};
  for (const [name, ch] of channels) rec[name] = ch;
  return rec;
}

function wrap(
  session: RunnerSession,
  endpoint: string,
  channels: Map<string, TrickleChannel>,
): StreamSession {
  return {
    session,
    endpoint,
    channels,
    snapshot() {
      return {
        sessionId: session.sessionId,
        appUrl: session.appUrl,
        runnerUrl: session.runnerUrl,
        controlUrl: session.controlUrl,
        runner: session.runner,
        endpoint,
        channels: channelsRecord(channels),
        payment: session.paymentSession?.snapshot() ?? null,
      };
    },
    channelUrl(name: string) {
      return channelUrl(channels, name);
    },
    call(options: CallSessionOptions) {
      return callSession(session, options);
    },
    stop(options?: StopSessionOptions) {
      return stopSession(session, options);
    },
  };
}

/**
 * Reserve without funding (unless `startFunding: true`), POST the app stream
 * endpoint, parse trickle channel URLs. `snapshot()` is enough to resume the
 * payment loop in another process via `resumeStreamSession`.
 */
export async function openStreamSession(
  options: OpenStreamSessionOptions,
): Promise<StreamSession> {
  const endpoint = options.endpoint.trim();
  if (!endpoint) {
    throw new LivepeerGatewayError("openStreamSession requires endpoint");
  }
  const session = await reserveSession({
    ...options,
    startFunding: options.startFunding === true,
  });
  const result = await callSession(session, {
    endpoint,
    payload: options.streamPayload ?? {},
    timeoutMs: options.callTimeoutMs ?? options.timeoutMs,
    insecureTls: options.insecureTls,
  });
  const channels = parseTrickleChannels(result.data);
  return wrap(session, endpoint.startsWith("/") ? endpoint : `/${endpoint}`, channels);
}

/**
 * Rebuild a `StreamSession` from a snapshot. Does not re-POST the stream
 * endpoint — the channels and runner URLs are restored as-is. Starts the 3s
 * funding loop unless `startFunding: false`.
 */
export function resumeStreamSession(options: ResumeStreamSessionOptions): StreamSession {
  const snap = options.snapshot;
  const paymentSession =
    snap.payment === null
      ? null
      : LivePaymentSession.fromSnapshot({
          signerUrl: options.signerUrl,
          signerHeaders: options.signerHeaders,
          snapshot: snap.payment,
        });
  const funding =
    options.startFunding === false || !paymentSession ? null : paymentSession.startFunding();
  const session: RunnerSession = {
    sessionId: snap.sessionId,
    appUrl: snap.appUrl,
    runnerUrl: snap.runnerUrl,
    controlUrl: snap.controlUrl,
    runner: snap.runner,
    released: false,
    paymentSession,
    async stopPayments() {
      if (funding) await funding.cancel();
    },
  };
  const channels = new Map(Object.entries(snap.channels));
  return wrap(session, snap.endpoint, channels);
}

export function streamAppUrl(session: RunnerSession, endpoint: string): string {
  const ep = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  return joinEndpoint(session.appUrl, ep);
}
