import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChangeEvent,
  PointerEvent as ReactPointerEvent,
  TouchEvent as ReactTouchEvent,
} from "react";
import type {
  AppPhase,
  BrowserBucket,
  CapabilityReport,
  ImageSource,
  OutputMode,
  OversizeDecision,
  ProcessError,
  ProcessRequest,
  ProcessResponse,
} from "./types";

import { getCapabilityReport, getFourXSupport } from "./lib/capabilities";
import {
  FOUR_X_MAX_MEGAPIXELS,
  OUTPUT_MAX_MEGAPIXELS,
  canUseFourXSource,
  clampStrength as clampStrengthValue,
  getOversizeDecision,
  inspectImageFile,
  revokeObjectUrl as revokeObjectUrlHelper,
} from "./lib/image";
import { DEFAULT_JPEG_QUALITY } from "./lib/export";
import { processImageRequest } from "./lib/enhance";
import { Button, SectionHeader, StatusBadge, WorkflowSteps } from "./ui";

type ExportFormat = "image/png" | "image/jpeg";

type Processor = {
  process(request: ProcessRequest): Promise<ProcessResponse>;
  dispose(): void;
};

type PendingSource = {
  source: ImageSource;
  decision: OversizeDecision | null;
};

const DEFAULT_STRENGTH = 0.55;
const COMPARE_MIN = 0;
const COMPARE_MAX = 100;
const PROCESS_DEBOUNCE_MS = 180;
const FALLBACK_OVERSIZE_MEGAPIXELS = 24;
const FALLBACK_JPEG_QUALITY = 0.92;

function resolveOversizeThreshold(): number {
  return OUTPUT_MAX_MEGAPIXELS;
}

function resolveJpegQuality(): number {
  return DEFAULT_JPEG_QUALITY;
}

function resolveCreateImageSource() {
  return inspectImageFile;
}

function resolveGetOversizeDecision() {
  return getOversizeDecision;
}

function createWorkerProcessor(): Processor {
  const worker = new Worker(new URL("./workers/enhanceWorker.ts", import.meta.url), {
    type: "module",
  });

  return {
    process(request: ProcessRequest) {
      return new Promise<ProcessResponse>((resolve, reject) => {
        const onMessage = (event: MessageEvent<ProcessResponse | ProcessError>) => {
          const payload = event.data;
          cleanup();

          if (payload && typeof payload === "object" && "message" in payload && typeof payload.message === "string") {
            reject(new Error(payload.message));
            return;
          }

          resolve(payload as ProcessResponse);
        };

        const onError = (event: ErrorEvent) => {
          cleanup();
          reject(new Error(event.message || "이미지 처리에 실패했습니다."));
        };

        const cleanup = () => {
          worker.removeEventListener("message", onMessage);
          worker.removeEventListener("error", onError);
        };

        worker.addEventListener("message", onMessage, { once: true });
        worker.addEventListener("error", onError, { once: true });
        worker.postMessage(request);
      });
    },
    dispose() {
      worker.terminate();
    },
  };
}

function createProcessor(capabilities: CapabilityReport): Processor {
  if (capabilities.hasWorker && capabilities.hasOffscreenCanvas && capabilities.hasCreateImageBitmap) {
    return createWorkerProcessor();
  }

  return {
    process(request: ProcessRequest) {
      return processImageRequest(request, { usedWorker: false });
    },
    dispose() {
      // no-op: main-thread fallback uses direct function calls
    },
  };
}

function revokeObjectUrl(url?: string | null) {
  revokeObjectUrlHelper(url ?? undefined);
}

function clampStrength(value: number) {
  return clampStrengthValue(value);
}

function formatMegapixels(value: number) {
  return `${value.toFixed(1)} MP`;
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function formatDimensionLabel(width: number, height: number) {
  return `${width.toLocaleString()} × ${height.toLocaleString()} px`;
}

function formatBytes(value: number) {
  if (value >= 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }

  if (value >= 1024) {
    return `${Math.round(value / 1024)} KB`;
  }

  return `${value} B`;
}

function getBaseName(name: string) {
  const dotIndex = name.lastIndexOf(".");
  return dotIndex > 0 ? name.slice(0, dotIndex) : name;
}

function getExtension(mimeType: ExportFormat) {
  return mimeType === "image/png" ? "png" : "jpg";
}

function getFormatLabel(mimeType: ExportFormat) {
  return mimeType === "image/png" ? "PNG" : "JPG";
}

function buildBlockedMessage(capabilities: CapabilityReport) {
  if (capabilities.reason) {
    return capabilities.reason;
  }

  if (capabilities.bucket === "unsupported") {
    return "이 브라우저는 Image Enhancer 지원 출시 범위에 포함되지 않습니다.";
  }

  return "이 브라우저는 Image Enhancer V1에 필요한 기본 Worker 및 Canvas 기능을 제공하지 않습니다.";
}

function formatPhaseLabel(phase: AppPhase) {
  switch (phase) {
    case "idle":
      return "대기";
    case "awaiting-oversize-decision":
      return "대용량 결정 대기";
    case "processing":
      return "처리 중";
    case "ready":
      return "준비 완료";
    case "exporting":
      return "내보내는 중";
    case "compatibility-blocked":
      return "호환성 차단";
    case "error":
      return "오류";
    default:
      return phase;
  }
}

function formatBucketLabel(bucket: BrowserBucket) {
  switch (bucket) {
    case "desktop-chromium":
      return "데스크톱 Chromium";
    case "desktop-firefox":
      return "데스크톱 Firefox";
    case "mobile-safari":
      return "iOS Safari";
    case "mobile-chromium":
      return "Android Chrome";
    default:
      return "미지원";
  }
}

export default function App() {
  const capabilities = useMemo(() => getCapabilityReport(), []);
  const [phase, setPhase] = useState<AppPhase>(capabilities.supported ? "idle" : "compatibility-blocked");
  const [source, setSource] = useState<ImageSource | null>(null);
  const [pendingSource, setPendingSource] = useState<PendingSource | null>(null);
  const [result, setResult] = useState<ProcessResponse | null>(null);
  const [strength, setStrength] = useState(DEFAULT_STRENGTH);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("image/png");
  const [outputMode, setOutputMode] = useState<OutputMode>("original");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [comparePosition, setComparePosition] = useState(50);
  const [isComparing, setIsComparing] = useState(false);
  const processorRef = useRef<Processor | null>(null);
  const requestIdRef = useRef(0);
  const debounceRef = useRef<number | null>(null);
  const completedProcessKeyRef = useRef("");
  const latestSourceRef = useRef<ImageSource | null>(null);
  const latestPendingSourceRef = useRef<PendingSource | null>(null);
  const latestResultRef = useRef<ProcessResponse | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const promptHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const compareFrameRef = useRef<HTMLDivElement | null>(null);
  const debugPreviewUrlRef = useRef<string | null>(null);



  const oversizeThreshold = useMemo(() => resolveOversizeThreshold(), []);
  const jpegQuality = useMemo(() => resolveJpegQuality(), []);
  const blockedMessage = useMemo(() => buildBlockedMessage(capabilities), [capabilities]);
  const busy = phase === "processing" || phase === "exporting";

  useEffect(() => {
    if (!capabilities.supported) {
      return;
    }

    const processor = createProcessor(capabilities);
    processorRef.current = processor;

    return () => {
      processor.dispose();
      processorRef.current = null;
    };
  }, [capabilities]);

  useEffect(() => {
    latestSourceRef.current = source;
    latestPendingSourceRef.current = pendingSource;
    latestResultRef.current = result;
  }, [pendingSource, result, source]);

  useEffect(() => {
    const currentWindow = window as typeof window & {
      __imageEnhancerDebug?: {
        sourceName: string | null;
        exportFormat: ExportFormat;
        strength: number;
        previewObjectUrl: string | null;
        exportObjectUrl: string | null;
        debugPreviewUrl: string | null;
        strategy: string | null;
        dimensions: { width: number; height: number } | null;
      };
    };

    revokeObjectUrl(debugPreviewUrlRef.current);
    debugPreviewUrlRef.current = result ? URL.createObjectURL(result.debugPreviewPng) : null;

    currentWindow.__imageEnhancerDebug = {
      sourceName: source?.name ?? null,
      exportFormat,
      strength,
      previewObjectUrl: result?.preview.objectUrl ?? null,
      exportObjectUrl: result?.export.objectUrl ?? null,
      debugPreviewUrl: debugPreviewUrlRef.current,
      strategy: result ? `${outputMode}:${result.strategy}` : null,
      dimensions: result ? { width: result.width, height: result.height } : null,
    };

    return () => {
      revokeObjectUrl(debugPreviewUrlRef.current);
      debugPreviewUrlRef.current = null;
      currentWindow.__imageEnhancerDebug = undefined;
    };
  }, [exportFormat, outputMode, result, source, strength]);

  useEffect(() => {
    return () => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
      }

      revokeObjectUrl(debugPreviewUrlRef.current);
      revokeObjectUrl(latestSourceRef.current?.objectUrl);
      revokeObjectUrl(latestResultRef.current?.preview.objectUrl);
      revokeObjectUrl(latestResultRef.current?.export.objectUrl);
      revokeObjectUrl(latestPendingSourceRef.current?.source.objectUrl);
    };
  }, []);

  useEffect(() => {
    if (phase === "awaiting-oversize-decision") {
      promptHeadingRef.current?.focus();
    }
  }, [phase]);

  const replaceSource = useCallback((nextSource: ImageSource | null) => {
    setSource((current) => {
      if (current && current.objectUrl !== nextSource?.objectUrl) {
        revokeObjectUrl(current.objectUrl);
      }

      return nextSource;
    });
  }, []);

  const replacePendingSource = useCallback((nextPending: PendingSource | null) => {
    setPendingSource((current) => {
      if (current && current.source.objectUrl !== nextPending?.source.objectUrl) {
        revokeObjectUrl(current.source.objectUrl);
      }

      return nextPending;
    });
  }, []);

  const replaceResult = useCallback((nextResult: ProcessResponse | null) => {
    setResult((current) => {
      if (current && current.preview.objectUrl !== nextResult?.preview.objectUrl) {
        revokeObjectUrl(current.preview.objectUrl);
      }

      if (current && current.export.objectUrl !== nextResult?.export.objectUrl) {
        revokeObjectUrl(current.export.objectUrl);
      }

      return nextResult;
    });
  }, []);

  const getProcessKey = useCallback((targetSource: ImageSource, targetMode: OutputMode, targetStrength: number, targetFormat: ExportFormat) => {
    return [
      targetSource.objectUrl,
      targetMode,
      clampStrength(targetStrength).toFixed(2),
      targetFormat,
    ].join("|");
  }, []);


  const runProcess = useCallback(
    async (targetSource: ImageSource, targetMode: OutputMode, targetStrength: number, targetFormat: ExportFormat) => {
      const processor = processorRef.current;

      if (!processor) {
        throw new Error("이 브라우저에서는 처리 파이프라인을 사용할 수 없습니다.");
      }

      const nextRequestId = requestIdRef.current + 1;
      const processKey = getProcessKey(targetSource, targetMode, targetStrength, targetFormat);
      requestIdRef.current = nextRequestId;
      setErrorMessage(null);
      setPhase("processing");

      const response = await processor.process({
        source: targetSource,
        strength: clampStrength(targetStrength),
        outputMode: targetMode,
        outputMimeType: targetFormat,
        jpegQuality,
      });

      if (requestIdRef.current !== nextRequestId) {
        revokeObjectUrl(response.preview.objectUrl);
        revokeObjectUrl(response.export.objectUrl);
        return;
      }

      completedProcessKeyRef.current = processKey;
      replaceResult(response);
      setComparePosition(50);
      setPhase("ready");
    },
    [getProcessKey, jpegQuality, replaceResult],
  );


  const processPendingSelection = useCallback(
    async (targetSource: ImageSource, nextOutputMode: OutputMode) => {
      setPendingSource(null);
      replaceSource(targetSource);
      setOutputMode(nextOutputMode);
      await runProcess(targetSource, nextOutputMode, strength, exportFormat);
    },
    [exportFormat, replaceSource, runProcess, strength],
  );

  const resetProcessingState = useCallback(() => {
    completedProcessKeyRef.current = "";
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    requestIdRef.current += 1;
    processorRef.current?.dispose();
    processorRef.current = capabilities.supported ? createProcessor(capabilities) : null;
  }, [capabilities]);


  const handleFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {

      const file = event.target.files?.[0];

      if (!file) {
        return;
      }

      try {
        setErrorMessage(null);
        replaceResult(null);
        replacePendingSource(null);
        replaceSource(null);
        resetProcessingState();
        const createImageSource = resolveCreateImageSource();
        const getOversizeDecision = resolveGetOversizeDecision();
        const nextSource = await createImageSource(file);
        const oversizeDecision = getOversizeDecision(nextSource);
        const isOversize = nextSource.megapixels > oversizeThreshold;
        const nextOutputMode =
          outputMode === "4x" && !canUseFourXSource(nextSource.width, nextSource.height)
            ? "original"
            : outputMode;

        if (isOversize) {
          setOutputMode(nextOutputMode);
          replacePendingSource({
            source: nextSource,
            decision: oversizeDecision,
          });
          setPhase("awaiting-oversize-decision");
          return;
        }

        setOutputMode(nextOutputMode);
        replaceSource(nextSource);
        setPendingSource(null);
        await runProcess(nextSource, nextOutputMode, strength, exportFormat);

      } catch (error) {
        setPhase("error");
        setErrorMessage(error instanceof Error ? error.message : "이미지를 불러오지 못했습니다.");
      } finally {
        event.target.value = "";
      }
    },
    [exportFormat, outputMode, oversizeThreshold, replacePendingSource, replaceResult, replaceSource, resetProcessingState, runProcess, strength],
  );


  const handleOversizeChoice = useCallback(
    async (nextOutputMode: OutputMode) => {
      if (!pendingSource) {
        return;
      }

      try {
        await processPendingSelection(pendingSource.source, nextOutputMode);
      } catch (error) {
        setPhase("error");
        setErrorMessage(error instanceof Error ? error.message : "이미지 처리를 완료하지 못했습니다.");
      }
    },
    [pendingSource, processPendingSelection],
  );

  const handleOutputModeChange = useCallback(
    async (nextOutputMode: OutputMode) => {
      setOutputMode(nextOutputMode);

      if (!source || pendingSource || phase === "awaiting-oversize-decision") {
        return;
      }

      resetProcessingState();

      try {
        await runProcess(source, nextOutputMode, strength, exportFormat);
      } catch (error) {
        setPhase("error");
        setErrorMessage(error instanceof Error ? error.message : "이미지 처리를 완료하지 못했습니다.");
      }
    },
    [exportFormat, pendingSource, phase, resetProcessingState, runProcess, source, strength],
  );

  const handleExportFormatChange = useCallback(
    async (nextFormat: ExportFormat) => {
      setExportFormat(nextFormat);

      if (!source || pendingSource || phase === "awaiting-oversize-decision") {
        return;
      }

      resetProcessingState();

      try {
        await runProcess(source, outputMode, strength, nextFormat);
      } catch (error) {
        setPhase("error");
        setErrorMessage(error instanceof Error ? error.message : "이미지 처리를 완료하지 못했습니다.");
      }
    },
    [outputMode, pendingSource, phase, resetProcessingState, runProcess, source, strength],
  );

  useEffect(() => {
    if (!source || !result || phase !== "ready") {
      return;
    }

    const nextProcessKey = getProcessKey(source, outputMode, strength, exportFormat);
    if (completedProcessKeyRef.current === nextProcessKey) {
      return;
    }

    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
    }

    debounceRef.current = window.setTimeout(() => {
      runProcess(source, outputMode, strength, exportFormat).catch((error) => {
        setPhase("error");
        setErrorMessage(error instanceof Error ? error.message : "이미지 처리를 완료하지 못했습니다.");
      });
    }, PROCESS_DEBOUNCE_MS);

    return () => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [exportFormat, getProcessKey, outputMode, phase, result, runProcess, source, strength]);

  const handleStrengthChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setStrength(Number(event.target.value));

  }, []);

  const updateComparePosition = useCallback((clientX: number) => {
    const frame = compareFrameRef.current;

    if (!frame) {
      return;
    }

    const rect = frame.getBoundingClientRect();
    if (!rect.width) {
      return;
    }

    const nextPosition = ((clientX - rect.left) / rect.width) * 100;
    setComparePosition(Math.min(COMPARE_MAX, Math.max(COMPARE_MIN, nextPosition)));
  }, []);

  const handleComparePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {

    setIsComparing(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    updateComparePosition(event.clientX);
  }, [updateComparePosition]);

  const handleComparePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {

    if (!isComparing) {
      return;
    }

    updateComparePosition(event.clientX);
  }, [isComparing, updateComparePosition]);

  const handleComparePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {

    setIsComparing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const handleCompareTouch = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0] ?? event.changedTouches[0];
    if (!touch) {
      return;
    }

    updateComparePosition(touch.clientX);
  }, [updateComparePosition]);

  const handleExport = useCallback(async () => {
    if (!result || !source || phase !== "ready") {
      return;
    }

    try {
      setPhase("exporting");
      const link = document.createElement("a");
      link.href = result.export.objectUrl;
      link.download = `${getBaseName(source.name)}-보정본.${getExtension(exportFormat)}`;
      document.body.append(link);
      link.click();
      link.remove();
      setPhase("ready");
    } catch (error) {
      setPhase("error");
      setErrorMessage(error instanceof Error ? error.message : "파일을 내보내지 못했습니다.");
    }
  }, [exportFormat, phase, result, source]);

  const handleRetry = useCallback(async () => {
    if (!source || busy) {
      return;
    }

    resetProcessingState();

    try {
      await runProcess(source, outputMode, strength, exportFormat);
    } catch (error) {
      setPhase("error");
      setErrorMessage(error instanceof Error ? error.message : "이미지 처리를 완료하지 못했습니다.");
    }
  }, [busy, exportFormat, outputMode, resetProcessingState, runProcess, source, strength]);

  const capabilityRows = useMemo(
    () => [
      ["지원 버킷", formatBucketLabel(capabilities.bucket)],
      ["Canvas 2D", capabilities.hasCanvas2D ? "사용 가능" : "없음"],
      ["Web Worker", capabilities.hasWorker ? "사용 가능" : "없음"],
      ["createImageBitmap", capabilities.hasCreateImageBitmap ? "사용 가능" : "없음"],
      ["OffscreenCanvas", capabilities.hasOffscreenCanvas ? "사용 가능" : "없음"],
      ["WebGL2", capabilities.hasWebGL2 ? "사용 가능" : "없음"],
      ["WebGPU", capabilities.hasWebGPU ? "사용 가능" : "없음"],
    ],
    [capabilities],
  );

  const fourXSupport = useMemo(() => getFourXSupport(capabilities), [capabilities]);
  const fourXDisabledReason = useMemo(() => {
    if (!fourXSupport.supported) {
      return fourXSupport.reason;
    }

    if (source && !canUseFourXSource(source.width, source.height)) {
      return `4x 업스케일은 ${FOUR_X_MAX_MEGAPIXELS.toFixed(1)}MP 이하 원본에서만 완전한 4배 결과를 유지합니다.`;
    }

    return null;
  }, [capabilities, fourXSupport, source]);

  const statusMessage = useMemo(() => {
    if (phase === "processing") {
      if (outputMode === "4x") {
        return "4x 업스케일 처리 중입니다. 모델 로딩과 초해상도 복원 때문에 시간이 조금 걸릴 수 있습니다.";
      }

      if (outputMode === "2x") {
        return "2x 업스케일 처리 중입니다.";
      }

      return "이미지를 처리 중입니다.";
    }

    if (!result) {
      return exportFormat === "image/png"
        ? "현재 저장 형식은 PNG입니다. JPG는 고정 품질 0.92를 사용합니다."
        : `현재 저장 형식은 JPG이며 품질 ${Math.round(jpegQuality * 100)}%를 사용합니다.`;
    }

    switch (result.strategy) {
      case "original":
        return `Original로 준비되었습니다: ${formatDimensionLabel(result.width, result.height)}.`;
      case "original-clamped":
        return `Original을 ${oversizeThreshold}MP 한도로 조정했습니다: ${formatDimensionLabel(result.width, result.height)}.`;
      case "2x":
        return `2x 업스케일로 준비되었습니다: ${formatDimensionLabel(result.width, result.height)}.`;
      case "2x-clamped":
        return `2x 업스케일을 ${oversizeThreshold}MP 한도로 조정했습니다: ${formatDimensionLabel(result.width, result.height)}.`;
      case "4x":
        return `4x 업스케일로 준비되었습니다: ${formatDimensionLabel(result.width, result.height)}.`;
      default:
        return `4x 업스케일을 ${oversizeThreshold}MP 한도로 조정했습니다: ${formatDimensionLabel(result.width, result.height)}.`;
    }
  }, [exportFormat, jpegQuality, outputMode, oversizeThreshold, phase, result]);

  const promptState = phase === "awaiting-oversize-decision" ? pendingSource : null;
  const workflowStep: 1 | 2 | 3 = result && phase === "ready" ? 3 : source || promptState ? 2 : 1;


  return (
    <>
      <a className="skip-link" href="#main-content">본문으로 건너뛰기</a>
      <main className="app-shell" id="main-content">
      <section className="panel hero-panel">
        <div className="hero-content">
          <p className="eyebrow">Image Enhancer V1</p>
          <h1>Enhance Images,<br />Right in Your Browser</h1>
          <p className="hero-copy">
            브라우저에서 이미지를 보정하고, Original·2x·4x 결과를 비교한 뒤 PNG 또는 JPG로 저장하세요.
          </p>
          {capabilities.supported ? (
            <div className="hero-actions">
              <Button
                variant="primary"
                type="button"
                data-action="choose-image"
                onClick={() => fileInputRef.current?.click()}
              >
                이미지 선택
              </Button>
              <span>이미지는 브라우저 안에서만 처리됩니다.</span>
            </div>
          ) : null}
          <input
            ref={fileInputRef}
            id="image-input"
            className="sr-only"
            type="file"
            tabIndex={-1}
            accept="image/png,image/jpeg,image/webp,image/heic,image/heif"
            aria-label="보정할 이미지 선택"
            onChange={handleFileChange}
          />
        </div>
        <div className={`capability-pill ${capabilities.supported ? "is-supported" : "is-blocked"}`}>
          <span>{capabilities.supported ? "지원 브라우저" : "미지원 브라우저"}</span>
          <strong>{formatBucketLabel(capabilities.bucket)}</strong>
        </div>
      </section>

      {capabilities.supported ? (
        <WorkflowSteps currentStep={workflowStep} />
      ) : null}

      <section className="panel summary-panel">
        <SectionHeader
          title="실행 환경"
          description="이 브라우저에서 사용할 수 있는 이미지 처리 기능을 확인했습니다."
          action={<StatusBadge className={`phase-${phase}`}><span data-phase={phase}>{formatPhaseLabel(phase)}</span></StatusBadge>}
        />
        <details className="capability-details">
          <summary>환경 세부 정보 보기</summary>
          <p>V1은 데스크톱 Chromium과 Firefox를 우선 지원하며 브라우저 기본 디코드와 캔버스 색 처리에 의존합니다.</p>
          <dl className="capability-grid">
            {capabilityRows.map(([label, value]) => (
              <div key={label} className="capability-row">
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </details>
      </section>

      {phase === "compatibility-blocked" ? (
        <section className="panel blocked-panel">
          <h2>지원되지 않는 브라우저</h2>
          <p>{blockedMessage}</p>
          <p>지원되는 데스크톱 Chromium 또는 Firefox에서 다시 실행하세요.</p>
        </section>
      ) : (
        <>
          <section className="panel control-panel" id="controls">
            <SectionHeader
              title="이미지 조정"
              description={<>한 번에 한 장을 처리합니다. {oversizeThreshold}MP를 넘는 이미지는 출력 방식을 확인합니다.</>}
              action={source ? (
                <Button variant="quiet" type="button" onClick={() => fileInputRef.current?.click()}>
                  다른 이미지 선택
                </Button>
              ) : null}
            />

            <div className="control-grid">
              <label className="slider-card" htmlFor="strength">
                <span className="slider-label-row">
                  <span>보정 강도</span>
                  <strong>{formatPercent(strength)}</strong>
                </span>
                <input
                  id="strength"
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={strength}
                  onChange={handleStrengthChange}
                  disabled={!source || busy || phase === "awaiting-oversize-decision"}
                />
                <small>슬라이더를 움직이면 현재 이미지를 자동으로 다시 처리합니다.</small>
              </label>

              <fieldset className="export-card">
                <legend>출력 크기</legend>
                <label>
                  <input
                    type="radio"
                    name="output-mode"
                    value="original"
                    checked={outputMode === "original"}
                    onChange={() => handleOutputModeChange("original")}
                    disabled={!source || busy}
                  />
                  Original
                </label>
                <label>
                  <input
                    type="radio"
                    name="output-mode"
                    value="2x"
                    checked={outputMode === "2x"}
                    onChange={() => handleOutputModeChange("2x")}
                    disabled={!source || busy}
                  />
                  2x 업스케일
                </label>
                <label>
                  <input
                    type="radio"
                    name="output-mode"
                    value="4x"
                    checked={outputMode === "4x"}
                    onChange={() => handleOutputModeChange("4x")}
                    disabled={!source || busy || !!fourXDisabledReason}
                  />
                  4x 업스케일
                </label>
                {fourXDisabledReason ? <small>{fourXDisabledReason}</small> : null}
              </fieldset>

              <fieldset className="export-card">
                <legend>저장 형식</legend>
                <label>
                  <input
                    type="radio"
                    name="export-format"
                    value="image/png"
                    checked={exportFormat === "image/png"}
                    onChange={() => handleExportFormatChange("image/png")}
                    disabled={!source || busy}
                  />
                  PNG
                </label>
                <label>
                  <input
                    type="radio"
                    name="export-format"
                    value="image/jpeg"
                    checked={exportFormat === "image/jpeg"}
                    onChange={() => handleExportFormatChange("image/jpeg")}
                    disabled={!source || busy}
                  />
                  JPG
                </label>
                <small>JPG 저장은 고정 품질 {jpegQuality.toFixed(2)}를 사용합니다.</small>
              </fieldset>
            </div>

            {source ? (
              <div className="source-meta">
                <span>{source.name}</span>
                <span>{formatMegapixels(source.megapixels)}</span>
                <span>{formatDimensionLabel(source.width, source.height)}</span>
                <span>{formatBytes(source.estimatedRgbaBytes)}</span>
              </div>
            ) : null}
          </section>

          {promptState ? (
            <section className="panel prompt-panel" role="alert" aria-labelledby="oversize-title">
              <h2 ref={promptHeadingRef} id="oversize-title" tabIndex={-1}>대용량 이미지 출력 방식 선택</h2>
              <p>{promptState.decision?.message || `이 이미지는 ${oversizeThreshold}MP 기준을 초과합니다.`}</p>
              <div className="prompt-stats">
                <span>{promptState.source.name}</span>
                <span>{formatMegapixels(promptState.source.megapixels)}</span>
                <span>{formatDimensionLabel(promptState.source.width, promptState.source.height)}</span>
              </div>
              <div className="prompt-actions">
                <Button
                  variant="primary"
                  type="button"
                  data-action="keep-original"
                  onClick={() => handleOversizeChoice("original")}
                >
                  Original로 계속
                </Button>
                <Button type="button" data-action="downscale" onClick={() => handleOversizeChoice("2x")}>
                  2x 업스케일로 계속
                </Button>
              </div>
            </section>
          ) : null}

          {errorMessage ? (
            <section className="panel error-panel" role="alert">
              <h2>복구 가능한 오류</h2>
              <p>{errorMessage}</p>
              <p>이미지를 다시 선택하거나 저장 형식을 조정한 뒤 다시 시도하세요.</p>
              <div className="error-actions">
                {source ? (
                  <Button type="button" onClick={handleRetry} disabled={busy}>다시 시도</Button>
                ) : null}
                <Button variant="secondary" type="button" onClick={() => fileInputRef.current?.click()}>
                  다른 이미지 선택
                </Button>
              </div>
            </section>
          ) : null}

          <section className="panel compare-panel" id="compare">
            <SectionHeader
              title="결과 비교"
              description="프레임을 드래그하거나 아래 슬라이더를 사용해 원본과 보정 결과를 비교하세요."
              action={result ? (
                <div className="render-meta">
                  <span>{result.strategy === "original" ? "Original" : result.strategy === "original-clamped" ? `${oversizeThreshold}MP로 조정된 Original` : result.strategy === "2x" ? "2x 업스케일" : result.strategy === "2x-clamped" ? `${oversizeThreshold}MP로 조정된 2x 업스케일` : result.strategy === "4x" ? "4x 업스케일" : `${oversizeThreshold}MP로 조정된 4x 업스케일`}</span>
                  <span>{formatDimensionLabel(result.width, result.height)}</span>
                  <span>{result.usedWorker ? "워커 처리" : "메인 스레드 처리"}</span>
                  <span>{Math.round(result.timingMs)} ms</span>
                </div>
              ) : null}
            />

            <div
              ref={compareFrameRef}
              className={`compare-frame ${result && !busy ? "is-ready" : "is-empty"}`}
              aria-busy={phase === "processing" || undefined}
              onPointerDown={result && !busy ? handleComparePointerDown : undefined}
              onPointerMove={result && !busy ? handleComparePointerMove : undefined}
              onPointerUp={result && !busy ? handleComparePointerUp : undefined}
              onPointerCancel={result && !busy ? handleComparePointerUp : undefined}
              onTouchStart={result && !busy ? handleCompareTouch : undefined}
              onTouchMove={result && !busy ? handleCompareTouch : undefined}
            >
              {source ? <img className="compare-image base-image" src={source.objectUrl} alt="원본 업로드 이미지" draggable={false} /> : null}
              {result && !busy ? (
                <div className="compare-overlay" style={{ clipPath: `inset(0 ${100 - comparePosition}% 0 0)` }}>
                  <img className="compare-image" src={result.preview.objectUrl} alt="보정된 미리보기" draggable={false} />
                </div>
              ) : null}
              {result && !busy ? (
                <div className="compare-handle" style={{ left: `${comparePosition}%` }} aria-hidden="true">
                  <span />
                </div>
              ) : null}
              {!source ? <div className="empty-state">이미지를 업로드하면 비교를 시작할 수 있습니다.</div> : null}
              {source && phase === "processing" ? (
                <div className="processing-state" role="status" aria-live="polite">
                  <span className="processing-skeleton" aria-hidden="true" />
                  <strong>{outputMode === "4x" ? "4x 모델로 이미지를 복원하는 중" : "미리보기를 만드는 중"}</strong>
                  <span>완료되면 비교 프레임과 저장 버튼이 자동으로 업데이트됩니다.</span>
                </div>
              ) : null}
            </div>
            <label className={`compare-control ${result ? "" : "is-disabled"}`} htmlFor="compare-position">
              <span>비교 위치</span>
              <strong>{Math.round(comparePosition)}%</strong>
              <input
                id="compare-position"
                type="range"
                min={0}
                max={100}
                step={1}
                value={comparePosition}
                disabled={!result || busy}
                aria-valuetext={`보정 이미지 ${Math.round(comparePosition)}% 표시`}
                onChange={(event) => setComparePosition(Number(event.target.value))}
              />
            </label>

            <div className="export-row" id="export">
              <div className="live-status" role="status" aria-live="polite" aria-atomic="true">
                <strong>{busy ? "처리 중" : result ? "저장 준비 완료" : "이미지 대기 중"}</strong>
                <p>{statusMessage}</p>
              </div>
              <Button
                variant="primary"
                type="button"
                data-action="export-image"
                onClick={handleExport}
                disabled={!result || phase !== "ready"}
                busy={phase === "exporting"}
              >
                {`${getFormatLabel(exportFormat)}로 저장`}
              </Button>
            </div>
          </section>
        </>
      )}
      </main>
    </>
  );
}
