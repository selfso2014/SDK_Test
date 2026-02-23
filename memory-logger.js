/**
 * memory-logger.js — SeeSo Debug Logger (경량 텍스트 버전)
 *
 * 로그 형식: [elapsed][LEVEL][TAG] message  {data}
 * 다운로드: .txt 파일 (JSON 아님)
 */

const MemoryLogger = (() => {
    const MAX_LINES = 500;
    const lines = [];          // 저장되는 텍스트 라인 배열
    const startTime = Date.now();

    const IS_IOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    const IS_SAFARI = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    const IS_ANDROID = /Android/i.test(navigator.userAgent);
    const DEVICE = IS_IOS ? '🍎iOS' : IS_ANDROID ? '🤖And' : '💻PC';

    let gazeCount = 0;
    let gazeWindowStart = Date.now();
    let gazeHz = 0;

    // ── 메모리 정보 (한 줄 요약) ────────────────────────────────
    function memStr() {
        const m = performance?.memory;
        if (m) return `${(m.usedJSHeapSize / 1048576).toFixed(1)}MB/${(m.jsHeapSizeLimit / 1048576).toFixed(0)}MB`;
        return IS_IOS ? 'mem=N/A(iOS)' : 'mem=N/A';
    }

    // ── 핵심: 한 줄 텍스트 로그 생성 ───────────────────────────
    function addLine(level, tag, message, data) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

        // 데이터가 있으면 간단한 인라인 표현
        let dataStr = '';
        if (data !== undefined && data !== null) {
            try {
                const s = typeof data === 'string' ? data : JSON.stringify(data);
                dataStr = '  ' + s.slice(0, 120); // 최대 120자
            } catch (_) { dataStr = '  [unparseable]'; }
        }

        const line = `[${elapsed}s][${level}][${tag}] ${message}${dataStr}`;
        lines.push(line);
        if (lines.length > MAX_LINES) lines.shift();

        // 콘솔 출력
        if (level === 'ERROR') console.error(line);
        else if (level === 'WARN') console.warn(line);
        else console.log(line);

        // UI 패널 업데이트
        updatePanel(level, line);
        return line;
    }

    // ── 퍼블릭 API ──────────────────────────────────────────────
    function info(tag, msg, data) { return addLine('INFO', tag, msg, data); }
    function warn(tag, msg, data) { return addLine('WARN', tag, msg, data); }
    function error(tag, msg, data) { return addLine('ERR ', tag, msg, data); }

    // 스냅샷: 상태 전환 시 메모리 찍기
    function snapshot(label) {
        return addLine('SNAP', 'MEM', `${label}  hz=${gazeHz} ${memStr()}`);
    }

    // gaze Hz 측정
    function countGaze() {
        gazeCount++;
        const now = Date.now();
        if (now - gazeWindowStart >= 1000) {
            gazeHz = Math.round((gazeCount / (now - gazeWindowStart)) * 1000);
            gazeCount = 0;
            gazeWindowStart = now;
            // 헤더 Hz 업데이트
            const el = document.getElementById('gaze-fps');
            if (el) el.textContent = gazeHz;
            updateStatsPanel();
        }
    }

    // ── 전역 에러 캐치 ──────────────────────────────────────────
    window.addEventListener('error', (e) => {
        error('GLOBAL', `${e.message}`, `${e.filename}:${e.lineno}`);
    });
    window.addEventListener('unhandledrejection', (e) => {
        error('GLOBAL', `UnhandledRejection: ${e.reason?.message || String(e.reason)}`);
    });

    // ── 주기적 상태 (30초마다) ───────────────────────────────────
    setInterval(() => {
        snapshot('PERIODIC');
    }, 30000);

    // ── 다운로드: 텍스트 파일 ───────────────────────────────────
    function downloadLogs() {
        const now = new Date();
        const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);

        const header = [
            `=== SeeSo Debug Log ===`,
            `Time   : ${now.toISOString()}`,
            `Device : ${DEVICE} | Safari=${IS_SAFARI}`,
            `UA     : ${navigator.userAgent.slice(0, 100)}`,
            `Screen : ${window.screen.width}x${window.screen.height} dpr=${window.devicePixelRatio}`,
            `Elapsed: ${((Date.now() - startTime) / 1000).toFixed(1)}s`,
            `Lines  : ${lines.length}`,
            `=========================`,
            '',
        ].join('\n');

        const blob = new Blob([header + lines.join('\n')], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `seeso-log-${ts}.txt`;
        a.style.display = 'none';
        // Android Chrome: body에 append 후 클릭해야 다운로드 동작
        document.body.appendChild(a);
        a.click();
        // revokeObjectURL 지연: 즉시 호출 시 Android에서 다운로드 전에 URL 무효화될 수 있음
        setTimeout(() => {
            URL.revokeObjectURL(url);
            document.body.removeChild(a);
        }, 5000);
    }

    // ── UI 패널 (우하단 오버레이) ────────────────────────────────
    let logListEl = null;
    let statsEl = null;
    let minimized = false;

    function initPanel() {
        if (document.getElementById('ml-panel')) return;

        const panel = document.createElement('div');
        panel.id = 'ml-panel';
        Object.assign(panel.style, {
            position: 'fixed', bottom: '0', right: '0',
            width: '300px', maxHeight: '35vh',
            background: 'rgba(8,8,20,0.93)',
            color: '#ccc', fontFamily: 'monospace', fontSize: '10px',
            zIndex: '99999', borderRadius: '8px 0 0 0',
            overflow: 'hidden', display: 'flex', flexDirection: 'column',
            boxShadow: '0 -2px 16px rgba(0,0,0,0.6)',
        });

        panel.innerHTML = `
          <div id="ml-hdr" style="background:#1a1a3a;padding:4px 8px;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;cursor:pointer;">
            <span style="color:#88aaff;font-weight:bold;">📊 Debug</span>
            <div style="display:flex;gap:6px;">
              <button onclick="MemoryLogger.downloadLogs()" style="background:#2a2a5a;color:#aaf;border:1px solid #44f;border-radius:3px;padding:1px 6px;cursor:pointer;font-size:10px;">📥 저장</button>
              <button onclick="MemoryLogger.togglePanel()" id="ml-tog" style="background:#2a2a5a;color:#aaf;border:1px solid #44f;border-radius:3px;padding:1px 6px;cursor:pointer;font-size:10px;">－</button>
            </div>
          </div>
          <div id="ml-stats" style="padding:3px 8px;border-bottom:1px solid #222;flex-shrink:0;line-height:1.5;"></div>
          <div id="ml-list"  style="overflow-y:auto;flex-grow:1;padding:2px 6px;"></div>
        `;
        document.body.appendChild(panel);
        statsEl = document.getElementById('ml-stats');
        logListEl = document.getElementById('ml-list');
        updateStatsPanel();
    }

    function updateStatsPanel() {
        if (!statsEl) return;
        statsEl.innerHTML =
            `${DEVICE} | ${((Date.now() - startTime) / 1000).toFixed(0)}s | ` +
            `Hz:<b style="color:#6f6">${gazeHz}</b> | ` +
            `${memStr()} | lines:${lines.length}`;
    }

    function updatePanel(level, line) {
        if (!logListEl || minimized) return;
        const div = document.createElement('div');
        const colors = { INFO: '#aad', WARN: '#fd8', 'ERR ': '#f66', SNAP: '#afa' };
        div.style.color = colors[level] || '#ccc';
        div.style.borderBottom = '1px solid #1a1a2e';
        div.style.padding = '0';
        div.style.whiteSpace = 'pre-wrap';
        div.style.wordBreak = 'break-all';
        div.textContent = line;
        logListEl.appendChild(div);
        logListEl.scrollTop = logListEl.scrollHeight;
        // DOM 라인 수 제한
        while (logListEl.children.length > 150) logListEl.removeChild(logListEl.firstChild);
        updateStatsPanel();
    }

    function togglePanel() {
        minimized = !minimized;
        const list = document.getElementById('ml-list');
        const stats = document.getElementById('ml-stats');
        const btn = document.getElementById('ml-tog');
        if (list) list.style.display = minimized ? 'none' : '';
        if (stats) stats.style.display = minimized ? 'none' : '';
        if (btn) btn.textContent = minimized ? '＋' : '－';
        const panel = document.getElementById('ml-panel');
        if (panel) panel.style.maxHeight = minimized ? 'none' : '35vh';
    }

    // DOM 준비 후 패널 표시
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initPanel);
    else initPanel();

    // 초기 로그
    snapshot('APP_START');
    info('ENV', `${DEVICE} | UA=${navigator.userAgent.slice(0, 80)}`);

    return { info, warn, error, snapshot, countGaze, downloadLogs, togglePanel, getLines: () => lines };
})();

window.MemoryLogger = MemoryLogger;
