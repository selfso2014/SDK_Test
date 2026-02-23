/**
 * stress-tester.js — iOS 메모리 가용량 측정 도구
 *
 * 원리:
 *   READING 상태에서 10MB씩 ArrayBuffer를 할당하며
 *   iOS WebKit 프로세스 한계(크래시 지점)를 찾는다.
 *
 * 흐름:
 *   Level 0 (Baseline, 0MB 추가)
 *     → 5초 관찰 → 로그 저장
 *   Level 1 (+10MB)
 *     → 5초 관찰 → 로그 저장
 *   Level N → 크래시
 *     직전 저장 로그 = 마지막 증거
 *
 * 가용 메모리 = 크래시 직전 Level × CHUNK_MB
 */

const MemoryStressTester = (() => {
    const CHUNK_MB = 10;    // 한 번에 할당할 크기 (MB)
    const OBSERVE_SEC = 5;     // 레벨당 관찰 시간 (초)
    const MAX_LEVEL = 30;    // 최대 300MB (안전 상한)

    const BYTES_PER_MB = 1024 * 1024;

    let _buffers = [];          // 할당된 ArrayBuffer 보관 (GC 방지)
    let _level = 0;           // 현재 레벨
    let _running = false;
    let _timerId = null;
    let _startTime = 0;
    let _onUpdate = null;        // UI 업데이트 콜백

    // ── 총 할당량 ────────────────────────────────────────────────
    function totalAllocMB() {
        return _level * CHUNK_MB;
    }

    // ── 한 레벨 실행 ─────────────────────────────────────────────
    function _runLevel() {
        if (!_running) return;
        if (_level > MAX_LEVEL) {
            MemoryLogger.info('STRESS', `MAX_LEVEL(${MAX_LEVEL}) reached — no crash. Stop.`);
            _stop();
            return;
        }

        const allocMB = totalAllocMB();

        // ① 로그: 현재 레벨 진입
        MemoryLogger.info('STRESS',
            `▶ Level ${_level} | allocated=${allocMB}MB | ` +
            `elapsed=${((Date.now() - _startTime) / 1000).toFixed(1)}s`
        );
        MemoryLogger.snapshot(`STRESS_L${_level}`);

        // ② 이번 레벨에서 추가 할당 (Level 0은 할당 없음)
        if (_level > 0) {
            try {
                const buf = new ArrayBuffer(CHUNK_MB * BYTES_PER_MB);
                // ArrayBuffer를 실제로 사용해야 최적화로 제거되지 않음
                // → 첫 바이트에 0 쓰기 (강제 물리 메모리 커밋)
                const view = new Uint8Array(buf);
                view[0] = _level; // 레벨 번호 기록
                _buffers.push(buf);
                MemoryLogger.info('STRESS',
                    `  Allocated: ${CHUNK_MB}MB ` +
                    `(buffers=${_buffers.length}, ` +
                    `total=${_buffers.length * CHUNK_MB}MB)`
                );
            } catch (e) {
                // 할당 자체가 실패하면 OOM 도달
                MemoryLogger.error('STRESS', `❌ ArrayBuffer allocation FAILED → OOM`, { msg: e.message });
                MemoryLogger.downloadLogs(); // 즉시 저장
                _stop();
                return;
            }
        }

        // ③ OBSERVE_SEC 동안 관찰 후 → 로그 저장 → 다음 레벨
        _timerId = setTimeout(() => {
            // 이 레벨이 안정적으로 지남 → 로그 저장 (다음 레벨 크래시 대비)
            MemoryLogger.info('STRESS',
                `  ✅ Level ${_level} STABLE (${OBSERVE_SEC}s passed) ` +
                `total=${allocMB}MB — saving log...`
            );
            MemoryLogger.downloadLogs(); // 크래시 전 마지막 보험

            // 다음 레벨로
            _level++;
            if (_running) _runLevel();
        }, OBSERVE_SEC * 1000);

        // UI 업데이트
        if (_onUpdate) _onUpdate(_level, allocMB);
    }

    // ── 시작 ────────────────────────────────────────────────────
    function start(onUpdate) {
        if (_running) {
            MemoryLogger.warn('STRESS', 'Already running');
            return;
        }
        _buffers = [];
        _level = 0;
        _running = true;
        _startTime = Date.now();
        _onUpdate = onUpdate || null;

        MemoryLogger.info('STRESS', `=== Memory Stress Test START ===`);
        MemoryLogger.info('STRESS',
            `chunk=${CHUNK_MB}MB | observe=${OBSERVE_SEC}s | max=${MAX_LEVEL * CHUNK_MB}MB`
        );
        MemoryLogger.snapshot('STRESS_BASELINE');

        _runLevel();
    }

    // ── 중지 ────────────────────────────────────────────────────
    function _stop() {
        _running = false;
        if (_timerId) { clearTimeout(_timerId); _timerId = null; }
        MemoryLogger.info('STRESS', `=== Stress Test STOPPED at Level ${_level} (${totalAllocMB()}MB) ===`);
        if (_onUpdate) _onUpdate(-1, totalAllocMB()); // -1 = stopped
    }

    function stop() {
        _stop();
        // 메모리 해제
        _buffers = [];
        MemoryLogger.info('STRESS', 'Buffers released (GC eligible)');
    }

    function isRunning() { return _running; }
    function getLevel() { return _level; }
    function getTotalMB() { return totalAllocMB(); }

    return { start, stop, isRunning, getLevel, getTotalMB };
})();

window.MemoryStressTester = MemoryStressTester;
