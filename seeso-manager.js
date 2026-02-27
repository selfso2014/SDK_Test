/**
 * seeso-manager.js
 * SeeSo SDK 래퍼 — 공식 방법만 사용, 최소한의 추상화
 *
 * 핵심 원칙:
 * - EasySeeso.startTracking(onGaze, onDebug) 공식 시그니처 (2인자)
 * - 내부에서 getUserMedia() 호출 → 외부 stream 전달 없음
 * - 에러 발생 시 즉시 MemoryLogger에 기록
 * - 카메라 해상도 제어는 SDK 내부에 위임 (공식 방법 그대로)
 *
 * 흐름: initSDK() → startTracking() → startCalibration()
 *
 * [FIX-iOS] 주기적 SDK 재시작:
 *   SDK 내부 processFrame_()에서 ImageBitmap 미해제 + canvas GPU 재할당
 *   → iPad ~60초에 메모리 초과 크래시
 *   → 45초마다 deinit → init → startTracking 사이클로 메모리 회수
 *   → 캘리브레이션 데이터 백업/복원으로 재캘리브레이션 불필요
 */

// ── iOS 재시작 주기 (ms) ─────────────────────────────────────────
const SDK_RESTART_INTERVAL_MS = 45000; // 45초 (60초 크래시 전에 선제 재시작)

class SeesoManager {
    constructor() {
        this._seeso = null;        // EasySeeso 인스턴스
        this._onGaze = null;
        this._onDebug = null;
        this._initialized = false;
        this._tracking = false;

        this.state = {
            sdk: 'idle',   // idle | loading | initialized | failed
            tracking: 'idle',   // idle | starting | running | failed
            cal: 'idle',   // idle | running | done | failed
        };

        // ── [FIX-iOS] 재시작용 상태 ──────────────────────────────────
        this._licenseKey = null;       // 재초기화에 필요
        this._gameOnGaze = null;       // game.js에서 전달받은 원본 콜백
        this._gameOnDebug = null;      // game.js에서 전달받은 원본 콜백
        this._restartTimer = null;     // setTimeout ID
        this._isRestarting = false;    // 재시작 중 중복 방지
        this._restartCount = 0;        // 재시작 횟수 (디버그)
        this._isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    }

    // ── 상태 업데이트 ────────────────────────────────────────────
    _setState(key, value) {
        const prev = this.state[key];
        this.state[key] = value;
        MemoryLogger.info('STATE', `${key}: ${prev} → ${value}`);

        // 상태별 statusText 자동 업데이트
        const el = document.getElementById('status-text');
        if (!el) return;
        const messages = {
            'sdk:loading': '🔄 AI 모델 다운로드 중...',
            'sdk:initialized': '✅ SDK 초기화 완료',
            'sdk:failed': '❌ SDK 초기화 실패',
            'tracking:starting': '📷 카메라 권한 요청 중...',
            'tracking:running': '👁️ 시선 추적 중',
            'tracking:failed': '❌ 시선 추적 실패',
            'cal:running': '🎯 캘리브레이션 진행 중...',
            'cal:done': '✅ 캘리브레이션 완료',
            'cal:failed': '❌ 캘리브레이션 실패',
        };
        const msg = messages[`${key}:${value}`];
        if (msg) el.textContent = msg;
    }

    // ── 1단계: SDK 초기화 ────────────────────────────────────────
    async initSDK() {
        if (this._initialized) {
            MemoryLogger.warn('SDK', 'initSDK skipped: already initialized');
            return true;
        }

        this._setState('sdk', 'loading');
        MemoryLogger.snapshot('SDK_INIT_START');

        // 라이선스 키: prod(github.io) / dev(그 외)
        const LICENSE_KEY = window.location.hostname === 'selfso2014.github.io'
            ? 'prod_srdpyuuaumnsqoyk2pvdci0rg3ahsr923bshp32u'
            : 'dev_1ntzip9admm6g0upynw3gooycnecx0vl93hz8nox';

        // [FIX-iOS] 재시작 시 재사용하기 위해 저장
        this._licenseKey = LICENSE_KEY;

        MemoryLogger.info('SDK', `License: ${LICENSE_KEY.startsWith('prod') ? 'PROD' : 'DEV'} | Host: ${window.location.hostname}`);

        return new Promise((resolve) => {
            // 30초 타임아웃
            const timeout = setTimeout(() => {
                MemoryLogger.error('SDK', 'initSDK TIMEOUT (30s)');
                this._setState('sdk', 'failed');
                resolve(false);
            }, 30000);

            try {
                this._seeso = new EasySeeso();
                window.__seeso = this._seeso; // 디버그용 전역 참조

                this._seeso.init(
                    LICENSE_KEY,
                    () => {
                        // afterInitialized
                        clearTimeout(timeout);
                        this._initialized = true;
                        this._setState('sdk', 'initialized');
                        MemoryLogger.snapshot('SDK_INIT_DONE');
                        resolve(true);
                    },
                    () => {
                        // afterFailed
                        clearTimeout(timeout);
                        MemoryLogger.error('SDK', 'EasySeeso.init → afterFailed (license or WASM error)');
                        this._setState('sdk', 'failed');
                        resolve(false);
                    }
                );
            } catch (e) {
                clearTimeout(timeout);
                MemoryLogger.error('SDK', 'initSDK threw exception', { msg: e.message, stack: e.stack });
                this._setState('sdk', 'failed');
                resolve(false);
            }
        });
    }

    // ── 2단계: 시선 추적 시작 ────────────────────────────────────
    // async → await 가능: 카메라가 실제로 준비된 후 resolve
    // [FIX-iOS] 이전: 즉시 true 반환 → startCalibration이 카메라 준비 전 호출 → 검은 프레임
    // [FIX-iOS] 이후: Promise 반환 → caller가 await → 카메라 ready 보장
    async startTracking(onGaze, onDebug) {
        if (!this._seeso || !this._initialized) {
            MemoryLogger.error('TRACK', 'startTracking: SDK not initialized');
            return false;
        }

        // [FIX-iOS] 원본 게임 콜백 저장 (재시작 시 재사용)
        this._gameOnGaze = onGaze;
        this._gameOnDebug = onDebug;

        this._onGaze = (gazeInfo) => {
            MemoryLogger.countGaze();
            if (onGaze) onGaze(gazeInfo);
        };

        this._onDebug = (fps, latMin, latMax, latAvg) => {
            MemoryLogger.info('SDK_DBG', `FPS=${fps} lat(min=${latMin} max=${latMax} avg=${typeof latAvg?.toFixed === 'function' ? latAvg.toFixed(1) : latAvg}ms)`);
            const el = document.getElementById('gaze-fps');
            if (el) el.textContent = fps;
            if (onDebug) onDebug(fps, latMin, latMax, latAvg);
        };

        this._setState('tracking', 'starting');
        MemoryLogger.snapshot('TRACKING_START');

        try {
            // 공식 방법: 2인자 (stream 전달 없음)
            // Promise를 await → 카메라 스트림이 실제로 시작될 때까지 대기
            const ok = await this._seeso.startTracking(this._onGaze, this._onDebug);
            MemoryLogger.info('TRACK', `startTracking resolved: ${ok}`);
            this._tracking = ok;
            this._setState('tracking', ok ? 'running' : 'failed');
            if (ok) {
                MemoryLogger.snapshot('TRACKING_RUNNING');
                // [FIX-iOS] 추적 시작 성공 → 재시작 타이머 시작
                this._scheduleRestart();
            }
            return ok;
        } catch (e) {
            MemoryLogger.error('TRACK', 'startTracking threw', { msg: e?.message, stack: e?.stack });
            this._setState('tracking', 'failed');
            return false;
        }
    }

    // ── 3단계: 1포인트 캘리브레이션 ─────────────────────────────
    startCalibration(onNextPoint, onProgress, onFinished) {
        if (!this._seeso || !this._initialized) {
            MemoryLogger.error('CAL', 'startCalibration: SDK not initialized');
            return false;
        }

        this._setState('cal', 'running');
        MemoryLogger.snapshot('CAL_START');

        const ok = this._seeso.startCalibration(
            (x, y) => {
                MemoryLogger.info('CAL', `Next point: (${x.toFixed(0)}, ${y.toFixed(0)})`);
                if (onNextPoint) onNextPoint(x, y);
                // ⚠️ startCollectSamples() 필수: 이 호출이 없으면 progress가 0%에서 멈춤
                // onNextPoint 콜백 직후 SDK에 데이터 수집 시작을 명시적으로 지시해야 함
                try {
                    this._seeso.startCollectSamples();
                    MemoryLogger.info('CAL', 'startCollectSamples() called ✅');
                } catch (e) {
                    MemoryLogger.error('CAL', 'startCollectSamples() failed', { msg: e.message });
                }
            },
            (progress) => {
                if (onProgress) onProgress(progress);
            },
            (calibrationData) => {
                MemoryLogger.info('CAL', 'Calibration finished!');
                MemoryLogger.snapshot('CAL_DONE');
                this._setState('cal', 'done');
                if (onFinished) onFinished(calibrationData);
            },
            1  // 1포인트 캘리브레이션
        );

        if (!ok) {
            MemoryLogger.error('CAL', 'startCalibration returned false');
            this._setState('cal', 'failed');
        }

        return ok;
    }

    // ── 정지/해제 ────────────────────────────────────────────────
    stopTracking() {
        if (!this._seeso) return;
        MemoryLogger.info('TRACK', 'stopTracking called');
        this._cancelRestart(); // [FIX-iOS] 타이머 해제
        this._seeso.stopTracking();
        this._tracking = false;
    }

    deinit() {
        MemoryLogger.info('SDK', 'deinit called');
        MemoryLogger.snapshot('DEINIT');
        this._cancelRestart(); // [FIX-iOS] 타이머 해제
        this.stopTracking();
        if (this._seeso) {
            this._seeso.deinit();
            this._seeso = null;
        }
        this._initialized = false;
    }

    getState() { return { ...this.state }; }
    isTracking() { return this._tracking; }

    // ═══════════════════════════════════════════════════════════════
    // [FIX-iOS] 주기적 SDK 재시작 — ImageBitmap 메모리 누수 우회
    // ═══════════════════════════════════════════════════════════════

    /**
     * 재시작 타이머 시작 (iOS에서만 동작)
     */
    _scheduleRestart() {
        if (!this._isIOS) return; // PC에서는 불필요
        this._cancelRestart();
        this._restartTimer = setTimeout(() => this._doRestart(), SDK_RESTART_INTERVAL_MS);
        MemoryLogger.info('RESTART', `Timer scheduled: ${SDK_RESTART_INTERVAL_MS / 1000}s`);
    }

    /**
     * 재시작 타이머 취소
     */
    _cancelRestart() {
        if (this._restartTimer) {
            clearTimeout(this._restartTimer);
            this._restartTimer = null;
        }
    }

    /**
     * SDK 재시작 실행
     *
     * 1. 캘리브레이션 데이터 백업
     * 2. stopTracking + deinit (ImageCapture 해제 → GC 대상)
     * 3. 1500ms 대기 (SDK 내부 setTimeout 1000ms 완료 보장)
     * 4. new EasySeeso → init (WASM 재로드 없이 eyeTracker만 재초기화)
     * 5. startTracking (새 카메라 스트림 + 새 ImageCapture)
     * 6. 캘리브레이션 복원 (재캘리브레이션 불필요)
     */
    async _doRestart() {
        if (this._isRestarting) return;
        this._isRestarting = true;
        this._restartCount++;

        const restartId = this._restartCount;
        MemoryLogger.info('RESTART', `🔄 #${restartId} SDK restart for memory cleanup...`);
        MemoryLogger.snapshot(`RESTART_${restartId}_BEGIN`);

        // UI: 사용자에게 알림
        const statusEl = document.getElementById('status-text');
        const prevStatus = statusEl ? statusEl.textContent : '';
        if (statusEl) statusEl.textContent = '🔄 시스템 최적화 중...';

        // ── Step 1: 캘리브레이션 데이터 백업 ───────────────────────
        let calData = null;
        try {
            // EasySeeso.seeso = Seeso 싱글턴 → getCalibrationData() 호출
            calData = this._seeso?.seeso?.getCalibrationData?.() || null;
            if (calData) {
                MemoryLogger.info('RESTART', `Calibration data saved (${calData.length} chars)`);
            } else {
                MemoryLogger.warn('RESTART', 'No calibration data to save');
            }
        } catch (e) {
            MemoryLogger.warn('RESTART', 'getCalibrationData failed', { msg: e.message });
        }

        // ── Step 2: SDK 종료 ──────────────────────────────────────
        try {
            this._seeso.stopTracking();
        } catch (e) {
            MemoryLogger.warn('RESTART', 'stopTracking error (ignoring)', { msg: e.message });
        }
        try {
            this._seeso.deinit();
        } catch (e) {
            MemoryLogger.warn('RESTART', 'deinit error (ignoring)', { msg: e.message });
        }
        this._seeso = null;
        this._initialized = false;
        this._tracking = false;

        MemoryLogger.snapshot(`RESTART_${restartId}_DEINIT_DONE`);

        // ── Step 3: SDK 내부 cleanup 대기 ─────────────────────────
        // Seeso.deinitialize() 내부: setTimeout(1000ms) → eyeTracker = null
        // 1500ms 대기로 확실히 완료 보장 + GC 회수 시간
        await new Promise(r => setTimeout(r, 1500));

        MemoryLogger.snapshot(`RESTART_${restartId}_AFTER_WAIT`);

        // ── Step 4: SDK 재초기화 ──────────────────────────────────
        try {
            this._seeso = new EasySeeso();
            window.__seeso = this._seeso;
        } catch (e) {
            MemoryLogger.error('RESTART', 'new EasySeeso() failed', { msg: e.message });
            if (statusEl) statusEl.textContent = prevStatus;
            this._isRestarting = false;
            return;
        }

        const initOk = await new Promise((resolve) => {
            const timeout = setTimeout(() => {
                MemoryLogger.error('RESTART', 'Re-init TIMEOUT (15s)');
                resolve(false);
            }, 15000);

            try {
                this._seeso.init(
                    this._licenseKey,
                    () => { clearTimeout(timeout); resolve(true); },
                    () => { clearTimeout(timeout); resolve(false); }
                );
            } catch (e) {
                clearTimeout(timeout);
                MemoryLogger.error('RESTART', 'Re-init threw', { msg: e.message });
                resolve(false);
            }
        });

        if (!initOk) {
            MemoryLogger.error('RESTART', `#${restartId} Re-init FAILED — SDK unavailable`);
            if (statusEl) statusEl.textContent = '❌ SDK 재시작 실패';
            this._isRestarting = false;
            return;
        }

        this._initialized = true;
        MemoryLogger.info('RESTART', `#${restartId} Re-init OK ✅`);

        // ── Step 5: 시선 추적 재시작 ──────────────────────────────
        // 저장해둔 게임 콜백으로 래퍼 재생성
        this._onGaze = (gazeInfo) => {
            MemoryLogger.countGaze();
            if (this._gameOnGaze) this._gameOnGaze(gazeInfo);
        };

        this._onDebug = (fps, latMin, latMax, latAvg) => {
            MemoryLogger.info('SDK_DBG', `FPS=${fps} lat(min=${latMin} max=${latMax} avg=${typeof latAvg?.toFixed === 'function' ? latAvg.toFixed(1) : latAvg}ms)`);
            const el = document.getElementById('gaze-fps');
            if (el) el.textContent = fps;
            if (this._gameOnDebug) this._gameOnDebug(fps, latMin, latMax, latAvg);
        };

        try {
            const trackOk = await this._seeso.startTracking(this._onGaze, this._onDebug);
            if (!trackOk) {
                MemoryLogger.error('RESTART', `#${restartId} Re-startTracking returned false`);
                if (statusEl) statusEl.textContent = '❌ 카메라 재시작 실패';
                this._isRestarting = false;
                return;
            }
            this._tracking = true;
            MemoryLogger.info('RESTART', `#${restartId} Tracking restarted ✅`);
        } catch (e) {
            MemoryLogger.error('RESTART', `#${restartId} Re-startTracking threw`, { msg: e.message });
            if (statusEl) statusEl.textContent = '❌ 카메라 재시작 실패';
            this._isRestarting = false;
            return;
        }

        // ── Step 6: 캘리브레이션 복원 ─────────────────────────────
        if (calData) {
            try {
                await this._seeso.seeso.setCalibrationData(calData);
                MemoryLogger.info('RESTART', `#${restartId} Calibration restored ✅`);
            } catch (e) {
                MemoryLogger.warn('RESTART', `#${restartId} Calibration restore failed`, { msg: e.message });
                // 캘리브레이션 실패해도 gaze는 동작 (정확도만 감소)
            }
        }

        // ── Step 7: 완료 ──────────────────────────────────────────
        MemoryLogger.snapshot(`RESTART_${restartId}_COMPLETE`);
        MemoryLogger.info('RESTART', `🔄 #${restartId} SDK restart complete ✅ (total restarts: ${this._restartCount})`);

        // UI 복원
        if (statusEl) statusEl.textContent = prevStatus;

        this._isRestarting = false;

        // 다음 재시작 예약
        this._scheduleRestart();
    }
}

window.SeesoManager = SeesoManager;
