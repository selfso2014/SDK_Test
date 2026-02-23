/**
 * MemoryLogger - iPhone 크래시 원인 파악을 위한 메모리/성능 추적 모듈
 * 
 * 수집 항목:
 * - performance.memory (Chrome only)
 * - 상태 전환 시 타임스탬프 + 메모리 스냅샷
 * - gaze 콜백 호출 빈도
 * - 전역 오류 캐치 (error, unhandledrejection)
 * - iOS 전용 추가 경고
 */

const MemoryLogger = (() => {
    const MAX_LOGS = 1000;
    const logs = [];
    const startTime = Date.now();

    // ── 기기/환경 정보 ──────────────────────────────────────────
    const IS_IOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    const IS_SAFARI = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    const IS_ANDROID = /Android/i.test(navigator.userAgent);
    const UA = navigator.userAgent;

    // ── gaze 통계 추적 ──────────────────────────────────────────
    let gazeCount = 0;
    let gazeLastWindowStart = Date.now();
    let gazeHz = 0;

    // ── 내부 헬퍼 ───────────────────────────────────────────────
    function getMemoryInfo() {
        // Chrome/Edge only: performance.memory
        const mem = performance?.memory;
        if (mem) {
            return {
                usedJSHeapMB: (mem.usedJSHeapSize / 1048576).toFixed(2),
                totalJSHeapMB: (mem.totalJSHeapSize / 1048576).toFixed(2),
                limitJSHeapMB: (mem.jsHeapSizeLimit / 1048576).toFixed(2),
                usedPct: ((mem.usedJSHeapSize / mem.jsHeapSizeLimit) * 100).toFixed(1) + '%',
            };
        }
        // iOS Safari: performance.memory 미지원 → 대체 정보
        return {
            usedJSHeapMB: 'N/A (iOS)',
            totalJSHeapMB: 'N/A',
            limitJSHeapMB: 'N/A',
            usedPct: 'N/A',
            note: IS_IOS ? 'iOS does not expose performance.memory' : 'Browser not supported',
        };
    }

    function getTimestamp() {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        return { wall: new Date().toISOString(), elapsedSec: parseFloat(elapsed) };
    }

    function addLog(level, tag, message, data) {
        const entry = {
            ...getTimestamp(),
            level,   // 'INFO' | 'WARN' | 'ERROR' | 'SNAP'
            tag,
            message,
            mem: getMemoryInfo(),
            ...(data ? { data } : {}),
        };

        logs.push(entry);
        if (logs.length > MAX_LOGS) logs.shift(); // 오래된 로그 제거

        // 콘솔 출력
        const prefix = `[${entry.elapsedSec}s][${level}][${tag}]`;
        if (level === 'ERROR') {
            console.error(prefix, message, data ?? '');
        } else if (level === 'WARN') {
            console.warn(prefix, message, data ?? '');
        } else {
            console.log(prefix, message, data ?? '');
        }

        // UI 패널 업데이트
        updatePanel(entry);
        return entry;
    }

    // ── 퍼블릭 API ──────────────────────────────────────────────
    function info(tag, message, data) { return addLog('INFO', tag, message, data); }
    function warn(tag, message, data) { return addLog('WARN', tag, message, data); }
    function error(tag, message, data) { return addLog('ERROR', tag, message, data); }

    /**
     * 상태 전환 시 메모리 스냅샷 기록
     * @param {string} label - 스냅샷 레이블 (예: 'SDK_INIT_DONE')
     */
    function snapshot(label) {
        return addLog('SNAP', 'MEMORY', label, {
            gazeHz,
            isIOS: IS_IOS,
            isSafari: IS_SAFARI,
        });
    }

    /**
     * gaze 콜백 호출 시마다 호출 — gaze Hz 계산
     */
    function countGaze() {
        gazeCount++;
        const now = Date.now();
        const elapsed = now - gazeLastWindowStart;
        if (elapsed >= 1000) {
            gazeHz = Math.round((gazeCount / elapsed) * 1000);
            gazeCount = 0;
            gazeLastWindowStart = now;
            updateStatsPanel();
        }
    }

    // ── 전역 에러 캐치 ──────────────────────────────────────────
    window.addEventListener('error', (e) => {
        error('GLOBAL', `Uncaught Error: ${e.message}`, {
            filename: e.filename,
            lineno: e.lineno,
            colno: e.colno,
            stack: e.error?.stack,
        });
    });

    window.addEventListener('unhandledrejection', (e) => {
        error('GLOBAL', `UnhandledRejection: ${e.reason?.message || String(e.reason)}`, {
            stack: e.reason?.stack,
        });
    });

    // ── 주기적 메모리 폴링 (5초마다) ────────────────────────────
    setInterval(() => {
        const mem = getMemoryInfo();
        // iOS가 아닌(Chrome) 경우에만 주기적 스냅샷을 로그에 남김
        if (mem.usedJSHeapMB !== 'N/A (iOS)') {
            // 메모리 사용율 70% 초과 시 경고
            const pct = parseFloat(mem.usedPct);
            if (pct > 70) {
                warn('MEM', `⚠️ High heap usage: ${mem.usedPct}`, mem);
            }
        }
        updateStatsPanel();
    }, 5000);

    // ── UI 패널 ─────────────────────────────────────────────────
    let panel = null;
    let statsEl = null;
    let logListEl = null;

    function initPanel() {
        // 이미 있으면 skip
        if (document.getElementById('ml-panel')) return;

        panel = document.createElement('div');
        panel.id = 'ml-panel';
        panel.innerHTML = `
      <div id="ml-header">
        <span>📊 Memory Debug</span>
        <div style="display:flex;gap:6px;align-items:center;">
          <button id="ml-toggle-btn" onclick="MemoryLogger.togglePanel()">최소화</button>
          <button id="ml-download-btn" onclick="MemoryLogger.downloadLogs()">📥 저장</button>
        </div>
      </div>
      <div id="ml-stats"></div>
      <div id="ml-loglist"></div>
    `;
        Object.assign(panel.style, {
            position: 'fixed',
            bottom: '0',
            right: '0',
            width: '320px',
            maxHeight: '40vh',
            background: 'rgba(10,10,30,0.92)',
            color: '#e0e0e0',
            fontFamily: 'monospace',
            fontSize: '11px',
            zIndex: '99999',
            borderRadius: '8px 0 0 0',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            boxShadow: '0 -2px 20px rgba(0,0,0,0.5)',
        });

        document.body.appendChild(panel);
        statsEl = document.getElementById('ml-stats');
        Object.assign(statsEl.style, {
            padding: '4px 8px',
            borderBottom: '1px solid #333',
            flexShrink: '0',
            lineHeight: '1.6',
        });

        logListEl = document.getElementById('ml-loglist');
        Object.assign(logListEl.style, {
            overflowY: 'auto',
            flexGrow: '1',
            padding: '4px 8px',
        });

        const header = document.getElementById('ml-header');
        Object.assign(header.style, {
            background: 'rgba(40,40,80,0.95)',
            padding: '5px 8px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            cursor: 'pointer',
            flexShrink: '0',
        });

        // 버튼 스타일
        ['ml-toggle-btn', 'ml-download-btn'].forEach(id => {
            const btn = document.getElementById(id);
            if (btn) {
                Object.assign(btn.style, {
                    background: '#2a2a5a',
                    color: '#aaf',
                    border: '1px solid #44f',
                    borderRadius: '4px',
                    padding: '2px 6px',
                    cursor: 'pointer',
                    fontSize: '10px',
                });
            }
        });

        updateStatsPanel();
    }

    let panelMinimized = false;
    function togglePanel() {
        panelMinimized = !panelMinimized;
        if (logListEl) logListEl.style.display = panelMinimized ? 'none' : 'block';
        if (statsEl) statsEl.style.display = panelMinimized ? 'none' : 'block';
        const btn = document.getElementById('ml-toggle-btn');
        if (btn) btn.textContent = panelMinimized ? '펼치기' : '최소화';
        if (panel) panel.style.maxHeight = panelMinimized ? 'auto' : '40vh';
    }

    function updateStatsPanel() {
        if (!statsEl) return;
        const mem = getMemoryInfo();
        const isIOS = IS_IOS ? '🍎 iOS' : (IS_ANDROID ? '🤖 Android' : '💻 PC');
        const isSafari = IS_SAFARI ? ' Safari' : '';
        statsEl.innerHTML = `
      <div>${isIOS}${isSafari} | Elapsed: <b>${((Date.now() - startTime) / 1000).toFixed(0)}s</b></div>
      <div>Heap: <b>${mem.usedJSHeapMB}MB</b> / ${mem.limitJSHeapMB}MB (<b>${mem.usedPct}</b>)</div>
      <div>Gaze Hz: <b>${gazeHz}</b> | Logs: <b>${logs.length}</b></div>
    `;
    }

    function updatePanel(entry) {
        if (!logListEl || panelMinimized) return;

        const div = document.createElement('div');
        const colors = { INFO: '#aaddff', WARN: '#ffdd88', ERROR: '#ff6666', SNAP: '#aaffaa' };
        div.style.color = colors[entry.level] || '#ccc';
        div.style.borderBottom = '1px solid #222';
        div.style.padding = '1px 0';

        let extra = '';
        if (entry.data) {
            try { extra = ' ' + JSON.stringify(entry.data).slice(0, 80); } catch (_) { }
        }
        div.textContent = `[${entry.elapsedSec}s][${entry.level}][${entry.tag}] ${entry.message}${extra}`;
        logListEl.appendChild(div);

        // 자동 스크롤
        logListEl.scrollTop = logListEl.scrollHeight;

        // 로그 라인 수 제한 (DOM이 너무 커지지 않도록)
        while (logListEl.children.length > 200) {
            logListEl.removeChild(logListEl.firstChild);
        }
    }

    function downloadLogs() {
        const payload = {
            meta: {
                exportedAt: new Date().toISOString(),
                elapsedSec: ((Date.now() - startTime) / 1000).toFixed(2),
                userAgent: UA,
                isIOS: IS_IOS,
                isSafari: IS_SAFARI,
                isAndroid: IS_ANDROID,
                screen: { w: window.screen.width, h: window.screen.height, dpr: window.devicePixelRatio },
            },
            logs,
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `seeso-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }

    // DOM 준비되면 패널 초기화
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initPanel);
    } else {
        initPanel();
    }

    // 초기 스냅샷
    snapshot('APP_START');
    info('ENV', `Device: ${IS_IOS ? 'iOS' : IS_ANDROID ? 'Android' : 'PC'} | Safari: ${IS_SAFARI}`, { ua: UA.slice(0, 120) });

    return { info, warn, error, snapshot, countGaze, downloadLogs, togglePanel, getLogs: () => logs };
})();

// 전역 접근 가능하도록
window.MemoryLogger = MemoryLogger;
