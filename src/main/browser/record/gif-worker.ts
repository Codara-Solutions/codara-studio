// Runs the GIF encoder on a worker thread, so encoding a long recording
// never stalls the main process (and with it every window and agent call).
// Frames go over one at a time and each waits for the worker's ack, which
// keeps at most one decoded frame in flight however slow the encoder is.

import { Worker } from "node:worker_threads";

import { createGifEncoder } from "./gif-encoder";

const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const createGifEncoder = (${createGifEncoder.toString()});
const encoder = createGifEncoder(workerData.width, workerData.height);
parentPort.on("message", (message) => {
  try {
    if (message.type === "frame") {
      encoder.addFrame(new Uint8Array(message.data), message.delayCs);
      parentPort.postMessage({ type: "ack" });
    } else if (message.type === "finish") {
      const bytes = encoder.finish();
      parentPort.postMessage({ type: "done", bytes }, [bytes.buffer]);
    }
  } catch (error) {
    parentPort.postMessage({ type: "error", message: String(error && error.message || error) });
  }
});
`;

export interface GifWorker {
  addFrame(rgba: Uint8Array, delayCs: number): Promise<void>;
  finish(): Promise<Buffer>;
  terminate(): void;
}

export function startGifWorker(width: number, height: number): GifWorker {
  const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { width, height } });
  let waiter: { resolve: (value: unknown) => void; reject: (error: Error) => void } | null = null;
  let failure: Error | null = null;
  const fail = (error: Error) => {
    failure = error;
    waiter?.reject(error);
    waiter = null;
  };
  worker.on("message", (message: { type: string; bytes?: Uint8Array; message?: string }) => {
    if (message.type === "error") return fail(new Error(`GIF encoding failed: ${message.message}`));
    const current = waiter;
    waiter = null;
    current?.resolve(message.bytes);
  });
  worker.on("error", (error) => fail(error));
  worker.on("exit", (code) => {
    if (waiter) fail(new Error(`The GIF encoder stopped (exit ${code}).`));
  });
  const request = <T>(message: Record<string, unknown>, transfer: ArrayBuffer[] = []): Promise<T> => {
    if (failure) return Promise.reject(failure);
    return new Promise<T>((resolve, reject) => {
      waiter = { resolve: resolve as (value: unknown) => void, reject };
      worker.postMessage(message, transfer);
    });
  };
  return {
    async addFrame(rgba, delayCs) {
      const copy = rgba.slice();
      await request({ type: "frame", data: copy.buffer, delayCs }, [copy.buffer as ArrayBuffer]);
    },
    async finish() {
      const bytes = await request<Uint8Array>({ type: "finish" });
      void worker.terminate();
      return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    },
    terminate() {
      void worker.terminate();
    },
  };
}
