/**
 * pang-detector.js — Max-Min Cascade Return Sweep Detector (V33.0 Optimized)
 *
 * TheBookWardens GazeDataManager.detectRealtimeReturnSweep()의
 * 메모리 최적화 독립 모듈.
 *
 * 핵심 최적화:
 *   1. Array-of-Objects 대신 TypedArray 순환버퍼를 직접 참조 (GC 없음)
 *   2. 프레임당 객체/배열 생성 0건 — hot path 완전 무할당
 *   3. 속도(vx) 인라인 계산 — preprocessData() 없음
 *   4. 상태: primitive 변수 7개 (Float64) 고정
 *   5. 라인 컨텍스트: Float32Array 기반 O(n) hit-test
 *
 * 알고리즘 (V33.0 스펙 준수):
 *   Step A: Position Peak   — 3-tap LPF smoothX, plateau(≥) 허용
 *   Step B: Velocity Valley — V-shape + depth < -0.4 px/ms
 *   Step C: Cascade Check   — |T_valley - T_peak| < 600ms (절대값, 역전 허용)
 *   Step D: Logic Guard     — line>0, maxLineReached 단조 증가, cooldown 500ms
 *   [FIRE]  onPang(targetLine, vx) 콜백
 *
 * 사용:
 *   const det = new PangDetector(gxBuf, gyBuf, gtBuf, bufSize, onPang);
 *   det.lockLayout(lineYs, lineHalfH);   // 지문 시작 시 1회
 *   det.process(gIdx, gCount);           // _onGaze 콜백 안에서 매번
 *   det.reset();                         // 지문 종료 시
 */

class PangDetector {
    /**
     * @param {Float32Array} gxBuf   - x 좌표 순환버퍼 (game.js의 this._gx)
     * @param {Float32Array} gyBuf   - y 좌표 순환버퍼 (game.js의 this._gy)
     * @param {Float64Array} gtBuf   - timestamp 순환버퍼 (game.js의 this._gt)
     * @param {number}       bufSize - 버퍼 크기 (MAX_GAZE_ENTRIES)
     * @param {Function}     onPang  - 감지 시 콜백: (targetLineIndex, vx) => void
     */
    constructor(gxBuf, gyBuf, gtBuf, bufSize, onPang) {
        // ── TypedArray 참조 (복사 없음, 소유권 없음) ──────────────────
        this._gx = gxBuf;
        this._gy = gyBuf;
        this._gt = gtBuf;
        this._N = bufSize;
        this._onPang = onPang;

        // ── 3-tap LPF 캐시: 이전 2프레임 smoothX ─────────────────────
        // smoothX(t) = 0.5*x(t) + 0.3*x(t-1) + 0.2*x(t-2)
        // → 현재 프레임 계산 시 이전 두 값이 필요 → 2개 primitive 캐시
        this._sx1 = 0.0;   // smoothX(t-1)
        this._sx2 = 0.0;   // smoothX(t-2)

        // ── 속도 캐시: 이전 1프레임 vx ────────────────────────────────
        // Valley 검사: v(t-2) > v(t-1) < v(t) → 3프레임 필요
        // v(t-0), v(t-1)은 산술로 즉시 계산, v(t-2)만 캐시
        this._vx2 = 0.0;   // vx(t-2)

        // ── Peak 추적 ─────────────────────────────────────────────────
        this._lastPeakTime = 0.0;   // 마지막 position peak 타임스탬프

        // ── Cascade / 쿨다운 상태 ─────────────────────────────────────
        this._lastTriggerTime = 0.0; // 마지막 pang 발화 타임스탬프
        this._maxLineReached = -1;  // 단조 증가 가드 (이미 도달한 최대 줄)

        // ── 콘텐츠 시작 시각 (이전 데이터로 오탐 방지) ─────────────────
        this._firstContentTime = 0.0;

        // ── 라인 컨텍스트 (lockLayout으로 주입) ───────────────────────
        this._lineYs = null;  // Float32Array: 각 라인 center Y (screen)
        this._lineHalf = 0;     // 라인 높이의 절반 (hit-test 범위)
        this._lineCount = 0;

        // ── 현재 읽는 라인 인덱스 ─────────────────────────────────────
        this._currentLine = null;  // null = 라인 경계 밖
        this._lastLineChangeT = 0.0;
    }

    // ─────────────────────────────────────────────────────────────────
    // PUBLIC: 지문 시작 시 1회 호출
    //   lineYs    — 각 라인 center Y 좌표 배열 (number[] 또는 Float32Array)
    //   lineHalfH — 라인 높이의 절반 (px)
    // ─────────────────────────────────────────────────────────────────
    lockLayout(lineYs, lineHalfH) {
        // Float32Array로 변환 (이미 Float32Array이면 그대로 참조)
        this._lineYs = lineYs instanceof Float32Array
            ? lineYs
            : new Float32Array(lineYs);
        this._lineHalf = lineHalfH;
        this._lineCount = this._lineYs.length;

        // 상태 초기화
        this._firstContentTime = performance.now();
        this._maxLineReached = -1;
        this._currentLine = null;
        this._lastLineChangeT = 0.0;
        this._lastPeakTime = 0.0;
        this._lastTriggerTime = 0.0;
        this._sx1 = 0.0;
        this._sx2 = 0.0;
        this._vx2 = 0.0;
    }

    // ─────────────────────────────────────────────────────────────────
    // PUBLIC: 매 gaze 콜백에서 호출 (hot path — 무할당)
    //   gIdx   — game.js의 this._gIdx (다음 쓰기 위치, 즉 방금 쓴 위치 + 1)
    //   gCount — game.js의 this._gCount
    // ─────────────────────────────────────────────────────────────────
    process(gIdx, gCount) {
        if (gCount < 3) return;

        const N = this._N;

        // 최근 3프레임 인덱스 (순환버퍼)
        const i0 = (gIdx - 1 + N) % N;  // t   (최신)
        const i1 = (gIdx - 2 + N) % N;  // t-1
        const i2 = (gIdx - 3 + N) % N;  // t-2

        const t0 = this._gt[i0];
        const t1 = this._gt[i1];
        // const t2 = this._gt[i2]; // 불필요 (vx 계산에 dt1 = t1 - t2 사용)
        const t2 = this._gt[i2];

        const x0 = this._gx[i0];
        const x1 = this._gx[i1];
        const x2 = this._gx[i2];
        const y0 = this._gy[i0];

        // ── A: 라인 hit-test (gaze Y → 현재 라인 인덱스) ──────────────
        // 할당 없음: _lineYs Float32Array 스캔
        this._updateLineFromGaze(y0, t0);

        // ── B: 3-tap LPF smoothX ───────────────────────────────────────
        const sx0 = x0 * 0.5 + x1 * 0.3 + x2 * 0.2;
        const sx1 = this._sx1;  // 이전 프레임 smoothX
        const sx2 = this._sx2;  // 2프레임 전 smoothX
        // 캐시 롤링 업데이트
        this._sx2 = sx1;
        this._sx1 = sx0;

        // ── C: 속도 계산 (px/ms) ──────────────────────────────────────
        const dt0 = t0 - t1; const dt1 = t1 - t2;
        const vx0 = dt0 > 0 ? (x0 - x1) / dt0 : 0.0;
        const vx1 = dt1 > 0 ? (x1 - x2) / dt1 : 0.0;
        const vx2 = this._vx2;
        // 캐시 롤링 업데이트
        this._vx2 = vx1;

        // ── D: Position Peak 감지 ─────────────────────────────────────
        // 조건 A: Geometric peak (sx1 ≥ sx2 AND sx1 > sx0) — plateau 허용
        // 조건 B: Velocity zero-crossing (vx1≥0 AND vx0<0)
        const isPosPeak = (sx1 >= sx2) && (sx1 > sx0);
        const isVelZeroCross = (vx1 >= 0) && (vx0 < 0);
        if (isPosPeak || isVelZeroCross) {
            this._lastPeakTime = t1;
        }

        // ── E: Velocity Valley 감지 ───────────────────────────────────
        // V-shape: vx2 > vx1 < vx0  (local minimum)
        // Depth  : vx1 < -0.4 px/ms (강도 임계값)
        const isVelValley = (vx2 > vx1) && (vx1 < vx0);
        const isDeepEnough = vx1 < -0.4;
        if (!isVelValley || !isDeepEnough) return;

        // ── F: Cascade Check ──────────────────────────────────────────
        // 콘텐츠 시작 전 트리거 방지
        const now = t0;
        if (!this._firstContentTime || now < this._firstContentTime) return;

        // 쿨다운 500ms
        if (now - this._lastTriggerTime < 500) return;

        // Cascade window: |T_valley - T_peak| < 600ms (절대값 — 역전 허용 V32.6)
        if (Math.abs(t1 - this._lastPeakTime) >= 600) return;

        // ── G: Logic Guard ────────────────────────────────────────────
        const line = this._currentLine;

        // null: 라인 경계 밖 → 보수적으로 skip
        if (line === null || line === undefined) return;

        // 첫 줄(0)에서 return sweep은 무시 (아직 읽기 시작 안 함)
        if (line === 0) return;

        // 단조 증가 가드: 이미 도달한 줄로 역행하는 트리거 방지
        if (line <= this._maxLineReached) return;

        // ── FIRE ──────────────────────────────────────────────────────
        this._lastTriggerTime = now;
        this._maxLineReached = line;
        this._lastPeakTime = 0.0;   // peak 리셋 (다음 줄 준비)

        // targetLine: return sweep는 line N에서 N+1로 넘어갈 때 발화
        // → 방금 완료한 줄은 N-1 (= line - 1)
        const targetLine = line - 1;
        this._onPang(targetLine, vx1);
    }

    // ─────────────────────────────────────────────────────────────────
    // PUBLIC: 지문 종료 또는 상태 전환 시 호출
    // ─────────────────────────────────────────────────────────────────
    reset() {
        this._sx1 = 0.0; this._sx2 = 0.0; this._vx2 = 0.0;
        this._lastPeakTime = 0.0;
        this._lastTriggerTime = 0.0;
        this._maxLineReached = -1;
        this._firstContentTime = 0.0;
        this._currentLine = null;
        this._lastLineChangeT = 0.0;
        this._lineYs = null;
        this._lineCount = 0;
    }

    // ─────────────────────────────────────────────────────────────────
    // PRIVATE: gaze Y → 현재 라인 인덱스 (O(n) 스캔, 할당 없음)
    // ─────────────────────────────────────────────────────────────────
    _updateLineFromGaze(gazeY, t) {
        if (!this._lineYs || this._lineCount === 0) return;

        const half = this._lineHalf;
        const ys = this._lineYs;
        const n = this._lineCount;

        for (let i = 0; i < n; i++) {
            if (gazeY >= ys[i] - half && gazeY <= ys[i] + half) {
                if (i !== this._currentLine) {
                    this._currentLine = i;
                    this._lastLineChangeT = t;
                }
                return;
            }
        }

        // 경계 밖: null (트리거 발화 안 함 — 보수적)
        // 단, 이미 라인 위에 있다가 잠깐 벗어난 경우를 위해
        // 현재 라인은 유지 (null로 바꾸지 않음)
        // → 일시적 노이즈에도 context가 끊어지지 않음
    }

    // ─────────────────────────────────────────────────────────────────
    // DEBUG: 현재 상태 로그 (MemoryLogger 있으면 출력)
    // ─────────────────────────────────────────────────────────────────
    debugState() {
        const msg = [
            `line=${this._currentLine}`,
            `maxReached=${this._maxLineReached}`,
            `lastPeak=${this._lastPeakTime.toFixed(0)}ms`,
            `lastTrigger=${this._lastTriggerTime.toFixed(0)}ms`,
            `sx1=${this._sx1.toFixed(1)}`,
            `vx2=${this._vx2.toFixed(3)}px/ms`,
        ].join(' | ');
        if (typeof MemoryLogger !== 'undefined') {
            MemoryLogger.info('PANG', msg);
        } else {
            console.log('[PangDetector]', msg);
        }
    }
}

window.PangDetector = PangDetector;
