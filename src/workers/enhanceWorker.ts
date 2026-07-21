import type { ProcessError, ProcessRequest, ProcessResponse } from "../types";
import { processImageRequest } from "../lib/enhance";
import { runFourXSuperResolution } from "../lib/srModel";

type WorkerScope = typeof globalThis & {
  onmessage: ((event: MessageEvent<ProcessRequest>) => void | Promise<void>) | null;
  postMessage: (message: ProcessResponse | ProcessError) => void;
};

const workerScope = self as WorkerScope;

workerScope.onmessage = async (event: MessageEvent<ProcessRequest>) => {
  try {
    const response = await processImageRequest(event.data, {
      usedWorker: true,
      runSuperResolution: runFourXSuperResolution,
    });
    workerScope.postMessage(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "이미지 보정 처리에 실패했습니다.";
    workerScope.postMessage({ message });
  }
};

export {};
