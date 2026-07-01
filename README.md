# Image Enhancer

브라우저 안에서 이미지를 보정하고, `Original` 또는 `2x` 출력으로 전후 비교 후 PNG/JPG로 저장하는 V1 프로젝트다.

## 배포 주소
- 프로덕션: https://hg-image-enhancer.vercel.app
- 배포 상세: https://hg-image-enhancer-qi8iohc46-puleun58-collabs-projects.vercel.app

## 요구 환경
- Node.js 20+
- npm 10+
- 자동 브라우저 검증까지 실행할 경우 Playwright 브라우저 설치 필요
- V1 공식 지원 범위는 데스크톱 Chromium / 데스크톱 Firefox다.
- 모바일 브라우저에서는 동작하더라도 출시 지원 범위로 보지 않는다.

## 설치 방법
```bash
npm install
```

자동 브라우저 검증까지 사용할 경우 한 번만 추가로 실행:
```bash
npx playwright install chromium firefox
```

## 실행 방법
### 1) 개발 서버
```bash
npm run dev
```
- 기본 Vite 개발 서버가 실행된다.
- 터미널에 표시된 주소를 브라우저에서 열면 된다.

### 2) 프로덕션 빌드
```bash
npm run build
```
- 정적 산출물은 `dist/`에 생성된다.

### 3) 빌드 결과 미리보기
```bash
npm run preview -- --host 127.0.0.1 --port 4674 --strictPort
```
- 로컬에서 최종 빌드 결과를 확인할 때 사용한다.
- `4674` 포트가 이미 사용 중이면 다른 포트로 바꿔서 실행한다.

## 자동 실행 방법
### 1) 단위 테스트
```bash
npm test
```
- `src/lib/*.test.ts` 테스트를 실행한다.

### 2) 자동 브라우저 검증
```bash
npm run qa:matrix
```
이 명령은 다음을 자동으로 수행한다.
1. `npm run build` 실행
2. `vite preview` 서버 실행
3. 데스크톱 고정 브라우저 매트릭스 검증 실행
   - 데스크톱 Chromium (`desktop-chromium`)
   - 데스크톱 Firefox (`desktop-firefox`)
4. 각 주요 fixture에 대해 미리보기 3회 실행 시간을 수집하고 중앙값을 계산
5. PNG/JPG 저장 시간, 저장 파일, 미리보기/내보내기 패리티 근거를 `artifacts/qa-matrix/`에 저장
6. 결과를 `artifacts/qa-matrix/qa-matrix.json`에 저장

주의:
- `qa:matrix`는 현재 데스크톱 공식 지원 범위만 자동 검증한다.
- 모바일 브라우저 동작은 참고 수준으로만 보고, 출시 지원 범위에는 포함하지 않는다.

## 폴더 구조
```text
.
├─ src/
│  ├─ App.tsx                 # 메인 UI, 업로드/강도/출력 모드/비교/저장 흐름
│  ├─ main.tsx                # React 진입점
│  ├─ styles.css              # 앱 스타일
│  ├─ types.ts                # 공용 타입 정의
│  ├─ lib/
│  │  ├─ capabilities.ts      # 브라우저 지원 판정과 capability 리포트
│  │  ├─ image.ts             # 이미지 로드, 24MP 출력 제한, 2x sizing 정책
│  │  ├─ enhance.ts           # 실제 보정 파이프라인과 처리 요청 조합
│  │  ├─ export.ts            # PNG/JPG Blob 생성과 export 보조 로직
│  │  ├─ *.test.ts            # 핵심 라이브러리 단위 테스트
│  └─ workers/
│     └─ enhanceWorker.ts     # 워커 기반 처리 경로
├─ fixtures/
│  ├─ text-heavy*.png/jpg     # 텍스트 보존 검증용 샘플
│  ├─ haze-heavy*.png/jpg     # 안개/저대비 검증용 샘플
│  ├─ noisy-low-light*.png/jpg# 저조도/노이즈 검증용 샘플
│  ├─ oversize.png            # 선택형 downscale 경로 검증용 샘플
│  └─ force-downscale-28mp.jpg# 강제 downscale 경로 검증용 샘플
├─ scripts/
│  └─ qa-matrix.mjs           # 자동 브라우저 QA 스크립트
├─ artifacts/
│  ├─ browser-smoke-ko.png    # 한국어 UI 스모크 검증 스크린샷
│  ├─ browser-automation.json # 데스크톱 브라우저 자동화 검증 기록
│  ├─ adversarial-report.txt  # 데스크톱 기준 adversarial 검증 요약
│  ├─ quality-gate-desktop.json # 최종 품질 게이트 입력 자료
│  └─ qa-matrix/              # 자동 검증 결과와 생성 산출물
├─ index.html                 # Vite HTML 엔트리
├─ package.json               # 스크립트/의존성 정의
└─ README.md                  # 현재 문서
```

## 자주 쓰는 명령 모음
```bash
npm install
npm test
npm run build
npm run dev
npm run preview -- --host 127.0.0.1 --port 4674 --strictPort
npm run qa:matrix
```

## 오류 대응 방법
### 1) 포트 충돌
증상:
- `vite preview` 실행 시 포트 사용 중 오류 발생

대응:
```bash
npm run preview -- --host 127.0.0.1 --port 4675 --strictPort
```
또는 기존 점유 프로세스를 종료한 뒤 다시 실행한다.

### 2) Playwright 브라우저 없음
증상:
- `npm run qa:matrix` 실행 시 브라우저 런치 실패

대응:
```bash
npx playwright install chromium firefox
```

### 3) 모바일 브라우저에서 열었을 때 지원 범위가 아닌 경우
증상:
- 자동 실행이나 수동 접속은 되더라도 앱이 데스크톱 우선 지원 범위 밖이라고 표시함

대응:
- 데스크톱 Chromium 계열 또는 데스크톱 Firefox에서 다시 실행한다.
- 모바일 동작 확인은 참고용으로만 수행하고, 공식 지원/승인은 데스크톱 기준으로 판단한다.

### 4) 지원되지 않는 브라우저 메시지 표시
증상:
- 앱 상단에 미지원 브라우저로 표시됨

대응:
- 데스크톱 Chromium 계열
- 데스크톱 Firefox
중 하나로 다시 실행한다.

### 5) 대용량 이미지 업로드 후 진행이 막힘
증상:
- 24MP를 넘는 이미지 업로드 시 출력 방식 선택 패널이 표시되거나 최종 출력이 자동으로 clamp됨

대응:
- `Original`은 원본 해상도를 우선 사용하되, 최종 출력이 24MP를 넘으면 비율을 유지한 채 자동으로 24MP 이하로 줄인다.
- `2x`는 가로/세로를 2배로 키우되, 최종 출력이 24MP를 넘으면 비율을 유지한 채 자동으로 24MP 이하로 줄인다.
- 더 큰 이미지는 `fixtures/force-downscale-28mp.jpg`처럼 강제 clamp 경로를 타게 된다

### 6) 자동 QA 도중 실패했을 때
우선 확인할 항목:
1. `artifacts/qa-matrix/qa-matrix.json`에서 어떤 타깃이 실패했는지 확인
2. 같은 폴더의 스크린샷과 저장 산출물 확인
3. 아래 순서로 다시 실행
```bash
npm test
npm run build
npm run qa:matrix
```

### 7) 빌드 결과가 이상하게 남아 있을 때
다시 빌드한다.
```bash
npm run build
```
필요하면 `dist/`와 `tsconfig*.tsbuildinfo`를 지운 뒤 다시 빌드한다.

## 수동 확인 방법
1. `npm run dev` 실행
2. 브라우저에서 앱 열기
3. 데스크톱 Chromium 또는 데스크톱 Firefox에서 확인
4. `fixtures/text-heavy.png` 업로드
5. 슬라이더를 움직여 재처리 확인
6. `Original` / `2x` 출력 모드 전환 확인
7. `PNG 저장` / `JPG 저장` 버튼 확인
8. `fixtures/oversize.png`와 `fixtures/force-downscale-28mp.jpg`로 24MP clamp 경로 확인
## 참고
- `qa:matrix`는 자동 검증 결과를 누적 산출물로 남긴다.
- `.gjc/` 폴더는 GJC 워크플로 상태/계획/증적용 내부 폴더다.
