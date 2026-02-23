/**
 * game.js
 * 게임 메인 상태 머신 컨트롤러
 *
 * 상태 흐름:
 * IDLE → SDK_INIT → CALIBRATION → READING → QUIZ → RESULT
 */

// 시선 데이터 롤링 버퍼 최대 크기: 60s @ 30Hz
const MAX_GAZE_ENTRIES = 1800; // 60s @ 30Hz

class Game {
    constructor() {
        this.seesoMgr = new SeesoManager();
        this.state = 'IDLE';         // 현재 게임 상태
        this.passageIndex = 0;       // 현재 지문 인덱스
        this.currentPassage = null;  // 현재 지문 데이터
        this.score = 0;              // 점수
        this.totalQuestions = 0;     // 총 문제 수

        // 시선 좌표
        this._gazeX = null;
        this._gazeY = null;
        this._gazeActive = false;    // gaze dot 표시 여부

        // ── 시선 데이터 버퍼 — TypedArray 순환버퍼 (할당 1회, GC 없음) ─────
        // push/shift 없이 인덱스만 순환 → 30Hz GC 압박 뭐
        this._gx = new Float32Array(MAX_GAZE_ENTRIES); // x 코오디네이트 (px)
        this._gy = new Float32Array(MAX_GAZE_ENTRIES); // y 코오디네이트 (px)
        this._gt = new Float64Array(MAX_GAZE_ENTRIES); // timestamp (unix ms)
        this._gIdx = 0;    // 다음 쓰기 위치
        this._gCount = 0;    // 실제 저장된 수

        // ── Pang Detector (Max-Min Cascade V33.0) ────────────────
        // TypedArray 순환버퍼를 직접 참조 → 프레임당 0 할당
        this._pangDetector = new PangDetector(
            this._gx, this._gy, this._gt, MAX_GAZE_ENTRIES,
            (lineIdx, vx) => this._onPang(lineIdx, vx)
        );

        // 캘리브레이션 UI
        this._calDotX = null;
        this._calDotY = null;
        this._calProgress = 0;
        this._calRafId = null;

        // gaze dot canvas
        this._gazeDotRafId = null;

        // ── 텍스트 라인 캐시 (pang 콜백에서 querySelectorAll 없이 접근) ─
        this._lineEls = null; // Array<HTMLElement> | null
    }

    // ── 상태 머신 진입 ───────────────────────────────────────────
    async setState(newState) {
        const prev = this.state;
        this.state = newState;
        MemoryLogger.info('GAME', `State: ${prev} → ${newState}`);
        MemoryLogger.snapshot(`GAME_STATE_${newState}`);

        // 모든 섹션 숨기기
        document.querySelectorAll('.game-section').forEach(el => el.classList.remove('active'));

        // 해당 섹션 표시
        const sectionMap = {
            IDLE: 'section-idle',
            SDK_INIT: 'section-loading',
            CALIBRATION: 'section-calibration',
            READING: 'section-reading',
            QUIZ: 'section-quiz',
            RESULT: 'section-result',
        };
        const sectionId = sectionMap[newState];
        if (sectionId) {
            const el = document.getElementById(sectionId);
            if (el) el.classList.add('active');
        }
    }

    // ── IDLE → SDK_INIT → CALIBRATION ──────────────────────────
    async start() {
        MemoryLogger.info('GAME', '=== Game Start ===');
        await this.setState('SDK_INIT');
        document.getElementById('status-text').textContent = '🔄 AI 모델 다운로드 중...';

        const sdkOk = await this.seesoMgr.initSDK();
        if (!sdkOk) {
            document.getElementById('status-text').textContent = '❌ SDK 초기화 실패. 새로고침 후 재시도 해주세요.';
            document.getElementById('btn-retry').style.display = 'block';
            return;
        }

        // SDK 완료 → 시선 추적 시작
        // easy-seeso.js 공식 방식: startTracking(onGaze, onDebug) 2인자
        // 내부에서 getUserMedia + 카메라 권한 요청을 처리함
        document.getElementById('status-text').textContent = '📷 카메라 권한을 허용해주세요...';
        this.seesoMgr.startTracking(
            (gazeInfo) => this._onGaze(gazeInfo),
            (fps) => this._onDebug(fps)
        );

        // tracking은 비동기 → 캘리브레이션 화면 바로 이동
        await this.setState('CALIBRATION');
        document.getElementById('status-text').textContent = '🎯 화면 중앙의 점을 바라봐 주세요';
        this._startCalibrationUI();
    }

    // ── 캘리브레이션 UI ──────────────────────────────────────────
    _startCalibrationUI() {
        // 캘리브레이션 시작
        const ok = this.seesoMgr.startCalibration(
            (x, y) => this._onCalibrationNextPoint(x, y),
            (progress) => this._onCalibrationProgress(progress),
            (data) => this._onCalibrationFinished(data)
        );

        if (!ok) {
            document.getElementById('status-text').textContent = '❌ 캘리브레이션 시작 실패';
            MemoryLogger.error('GAME', 'Calibration start failed');
        }
    }

    _onCalibrationNextPoint(x, y) {
        this._calDotX = x;
        this._calDotY = y;
        this._calProgress = 0;

        // SDK 좌표 → 현재 viewport 기준으로 클램핑
        // SeeSo SDK는 내부 기준 해상도(PC) 좌표를 반환하므로
        // 모바일에서는 그대로 쓰면 화면 밖으로 나감
        const W = window.innerWidth;
        const H = window.innerHeight;
        const dotSize = 12; // 12px = 60px의 20%
        // 화면 안에 완전히 들어오도록 클램핑 (패딩 20px)
        const clampedX = Math.min(Math.max(x, dotSize / 2 + 20), W - dotSize / 2 - 20);
        const clampedY = Math.min(Math.max(y, dotSize / 2 + 20), H - dotSize / 2 - 20);

        MemoryLogger.info('CAL', `NextPoint raw(${Math.round(x)},${Math.round(y)}) → clamped(${Math.round(clampedX)},${Math.round(clampedY)}) viewport=${W}x${H}`);

        const dot = document.getElementById('cal-dot');
        if (dot) {
            dot.style.left = (clampedX - dotSize / 2) + 'px';
            dot.style.top = (clampedY - dotSize / 2) + 'px';
            dot.style.display = 'block';
            // 반짝이는 애니메이션 재시작
            dot.classList.remove('pulse');
            void dot.offsetWidth; // reflow
            dot.classList.add('pulse');
        }

        document.getElementById('status-text').textContent =
            `🎯 이 점을 바라봐 주세요 (${Math.round(clampedX)}, ${Math.round(clampedY)})`;
    }

    _onCalibrationProgress(progress) {
        this._calProgress = progress;
        const bar = document.getElementById('cal-progress-bar');
        if (bar) bar.style.width = (progress * 100) + '%';
        const txt = document.getElementById('cal-progress-text');
        if (txt) txt.textContent = Math.round(progress * 100) + '%';
    }

    _onCalibrationFinished(data) {
        const dot = document.getElementById('cal-dot');
        if (dot) dot.style.display = 'none';

        // 캘리브레이션 완료 → 800ms 후 리딩 시작 (iOS GPU 버퍼 플러시 대기)
        MemoryLogger.info('GAME', '[FIX] 800ms GPU flush delay after calibration');
        setTimeout(() => this._startReading(), 800);
    }

    // ── 리딩 화면 ────────────────────────────────────────────────
    async _startReading() {
        this.currentPassage = PASSAGES[this.passageIndex];
        if (!this.currentPassage) {
            this._showResult();
            return;
        }

        // 새 지문 시작 → 시선 버퍼 인덱스 리셋 (TypedArray 데이터는 그대로 유지)
        this._gIdx = 0;
        this._gCount = 0;
        this._pangDetector.reset();

        await this.setState('READING');
        this._gazeActive = true;
        this._startGazeDot();

        // 지문 렌더링 + lockLayout (줄 Y 좌표 1회 캐시 → PangDetector 무장)
        document.getElementById('reading-title').textContent = this.currentPassage.title;
        this._initReading(this.currentPassage.text);
        document.getElementById('status-text').textContent = '📖 지문을 읽어주세요';
    }

    // ── 퀴즈 화면 ────────────────────────────────────────────────
    async showQuiz() {
        if (!this.currentPassage) return;

        // [FIX-MEM] READING → QUIZ 전환: 읽기 DOM 즉시 해제 + PangDetector 리셋
        this._destroyReading();

        // 시선 데이터 통계 로깅
        if (this._gCount > 0) {
            const lastIdx = (this._gIdx - 1 + MAX_GAZE_ENTRIES) % MAX_GAZE_ENTRIES;
            const firstIdx = this._gCount < MAX_GAZE_ENTRIES ? 0 : this._gIdx;
            const durMs = this._gt[lastIdx] - this._gt[firstIdx];
            const durSec = (durMs / 1000).toFixed(1);
            const hz = (this._gCount / Math.max(1, durMs / 1000)).toFixed(1);
            MemoryLogger.info('GAZE',
                `Reading stats: entries=${this._gCount} ` +
                `dur=${durSec}s avg_hz=${hz} ` +
                `passage=${this.currentPassage.id}`
            );
        }

        await this.setState('QUIZ');
        // 퀴즈 화면에서는 gaze dot 불필요 → RAF 중지 (iOS 메모리 절약)
        this._gazeActive = false;
        this._stopGazeDot();

        document.getElementById('quiz-question').textContent = this.currentPassage.question;

        const optionsEl = document.getElementById('quiz-options');
        optionsEl.innerHTML = '';
        this.currentPassage.options.forEach((opt, i) => {
            const btn = document.createElement('button');
            btn.className = 'option-btn';
            btn.textContent = opt;
            btn.addEventListener('click', () => this._onAnswer(i));
            optionsEl.appendChild(btn);
        });

        this.totalQuestions++;
        document.getElementById('status-text').textContent = '❓ 알맞은 답을 고르세요';
    }

    _onAnswer(selectedIndex) {
        const correct = this.currentPassage.answer;
        const isCorrect = selectedIndex === correct;

        if (isCorrect) this.score++;
        MemoryLogger.info('GAME', `Answer: selected=${selectedIndex} correct=${correct} result=${isCorrect ? 'CORRECT' : 'WRONG'}`);

        // 버튼 색상으로 정답/오답 표시
        const btns = document.querySelectorAll('.option-btn');
        btns.forEach((btn, i) => {
            btn.disabled = true;
            if (i === correct) btn.classList.add('correct');
            else if (i === selectedIndex) btn.classList.add('wrong');
        });

        // 1.5초 후 다음 지문 또는 결과
        setTimeout(() => {
            this.passageIndex++;
            if (this.passageIndex < PASSAGES.length) {
                this._startReading();
            } else {
                this._showResult();
            }
        }, 1500);
    }

    // ── 결과 화면 ────────────────────────────────────────────────
    async _showResult() {
        this._gazeActive = false;
        this._stopGazeDot();
        await this.setState('RESULT');
        MemoryLogger.snapshot('RESULT_SCREEN');

        document.getElementById('result-score').textContent =
            `${this.score} / ${this.totalQuestions}`;
        document.getElementById('result-msg').textContent =
            this.score === this.totalQuestions ? '🎉 완벽해요!' :
                this.score >= this.totalQuestions / 2 ? '👍 잘했어요!' : '📚 조금 더 연습해요!';
        document.getElementById('status-text').textContent = '게임 완료!';

        // 게임 완료 시 자동 로그 저장 (마지막 로그 누락 방지)
        // 1초 딜레이: RESULT 상태 로그가 모두 기록된 후 저장
        MemoryLogger.info('GAME', 'Auto-saving log on game completion...');
        setTimeout(() => {
            MemoryLogger.info('GAME', 'Auto-save triggered ✅');
            MemoryLogger.downloadLogs();
        }, 1000);
    }

    // ── 시선 콜백 ────────────────────────────────────────────────
    _onGaze(gazeInfo) {
        if (!gazeInfo) return;
        this._gazeX = gazeInfo.x;
        this._gazeY = gazeInfo.y;

        // READING 상태에서만 데이터 수집 + Pang 감지
        if (this.state === 'READING') {
            // TypedArray 순환버퍼에 쓰기 (GC 없음)
            this._gx[this._gIdx] = gazeInfo.x;
            this._gy[this._gIdx] = gazeInfo.y;
            this._gt[this._gIdx] = Date.now();
            this._gIdx = (this._gIdx + 1) % MAX_GAZE_ENTRIES;
            if (this._gCount < MAX_GAZE_ENTRIES) this._gCount++;

            // Max-Min Cascade Return Sweep 감지 (할당 0, DOM 읽기 0)
            this._pangDetector.process(this._gIdx, this._gCount);
        }
    }

    _onDebug(fps) {
        const el = document.getElementById('gaze-fps');
        if (el) el.textContent = fps;
    }

    // ── Gaze Dot 렌더링 ─────────────────────────────────────────
    _startGazeDot() {
        this._stopGazeDot();
        const canvas = document.getElementById('gaze-canvas');
        if (!canvas) return;

        // ⚠️ iOS 크래시 핵심 수정:
        // canvas.width/height를 매 프레임 설정하면 GPU 버퍼가 매번 재할당됨
        // → 60fps * 수십초 = 수천 번의 GPU 메모리 재할당 → iOS WebKit 프로세스 킬
        // 해결: 시작 시 1회만 설정, 이후 clearRect만 사용
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        const ctx = canvas.getContext('2d');
        MemoryLogger.info('GAME', `GazeDot start: canvas=${canvas.width}x${canvas.height}`);

        const draw = () => {
            if (!this._gazeActive) return;
            this._gazeDotRafId = requestAnimationFrame(draw);

            // GPU 버퍼 재할당 없이 지우기만 수행 (iOS 안전)
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            if (this._gazeX != null && this._gazeY != null &&
                Number.isFinite(this._gazeX) && Number.isFinite(this._gazeY)) {
                ctx.beginPath();
                ctx.arc(this._gazeX, this._gazeY, 10, 0, Math.PI * 2);
                ctx.fillStyle = 'rgba(255, 220, 0, 0.75)';
                ctx.fill();
                ctx.strokeStyle = 'rgba(0,0,0,0.5)';
                ctx.lineWidth = 2;
                ctx.stroke();
            }
        };
        draw();
    }

    _stopGazeDot() {
        if (this._gazeDotRafId) {
            cancelAnimationFrame(this._gazeDotRafId);
            this._gazeDotRafId = null;
        }
        const canvas = document.getElementById('gaze-canvas');
        if (canvas) {
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
    }

    // ── 읽기 시스템 (Pang Detector 기반) ───────────────────────────

    // READING → 퀴즈/결과 전환 시: DOM 즉시 해제 + PangDetector 리셋
    _destroyReading() {
        MemoryLogger.snapshot('BEFORE_DESTROY_READING');
        const container = document.getElementById('reading-text');
        const lineCount = this._lineEls ? this._lineEls.length : 0;
        if (container) container.innerHTML = '';
        this._lineEls = null; // 참조 해제 → GC 가능
        this._pangDetector.reset();
        MemoryLogger.info('GAME', `[MEM] _destroyReading: removed ${lineCount} lines, pangDetector reset`);
        MemoryLogger.snapshot('AFTER_DESTROY_READING');
    }

    // 지문 초기화:
    //   1. 단어 span으로 임시 렌더 → offsetTop으로 줄 경계 감지
    //   2. 줄 div로 재구성 (text-line)
    //   3. lockLayout: 각 줄 center Y를 Float32Array에 1회 캐시
    //   4. PangDetector.lockLayout() 호출 → 이후 gaze 콜백에서 무장
    _initReading(text) {
        const container = document.getElementById('reading-text');
        container.innerHTML = '';

        // Step 1: 단어 span 임시 렌더 (줄 감지용)
        text.split(/\s+/).filter(Boolean).forEach(word => {
            const s = document.createElement('span');
            s.style.display = 'inline';
            s.textContent = word + '\u00A0'; // non-breaking space 단어 구분
            container.appendChild(s);
        });

        // Step 2~4: 150ms 후 줄 재구성 + lockLayout
        // iOS에서 레이아웃 계산 완료 보장
        setTimeout(() => {
            const spans = Array.from(container.querySelectorAll('span'));
            const lineMap = new Map(); // offsetTop → word 배열

            spans.forEach(s => {
                const top = s.offsetTop;
                if (!lineMap.has(top)) lineMap.set(top, []);
                lineMap.get(top).push(s.textContent);
            });

            // Step 2: 줄 div 재구성
            container.innerHTML = '';
            const sortedTops = Array.from(lineMap.keys()).sort((a, b) => a - b);
            const lineEls = sortedTops.map(top => {
                const div = document.createElement('div');
                div.className = 'text-line';
                div.textContent = lineMap.get(top).join('');
                container.appendChild(div);
                return div;
            });

            MemoryLogger.info('GAME', `_initReading: ${lineEls.length} lines built`);

            // Step 3: lockLayout — 줄 center Y 1회 측정 → Float32Array
            this._lockLayout(lineEls);
        }, 150);
    }

    // 각 줄 center Y 좌표를 1회 측정하여 PangDetector에 전달
    // 이후 gaze 콜백에서는 DOM 접근 없이 Float32Array 스캔만 수행
    _lockLayout(lineEls) {
        const n = lineEls.length;
        if (n === 0) return;

        const lineYs = new Float32Array(n);
        let totalH = 0;

        lineEls.forEach((el, i) => {
            const r = el.getBoundingClientRect();
            lineYs[i] = r.top + r.height * 0.5; // center Y (screen 좌표)
            totalH += r.height;
        });

        // lineHalfH: 라인 높이 절반 * 1.1 (hit-test 여유 10%)
        const avgH = totalH / n;
        const lineHalfH = avgH * 0.55;

        // 디버그 로그
        MemoryLogger.info('GAME',
            `lockLayout: ${n} lines | avgH=${avgH.toFixed(1)} | halfH=${lineHalfH.toFixed(1)}`);
        for (let i = 0; i < n; i++) {
            MemoryLogger.info('GAME', `  L${i}: centerY=${lineYs[i].toFixed(0)}px`);
        }

        // PangDetector 무장: 이후 _onGaze → process() 호출 시 감지 시작
        this._pangDetector.lockLayout(lineYs, lineHalfH);

        // 라인 엘리먼트 캐시 저장 (pang 콜백에서 재사용)
        this._lineEls = lineEls;
    }

    // PangDetector가 줄 완료를 감지했을 때 호출되는 콜백
    // lineIdx: 방금 완료된 줄 인덱스 (0-based)
    // vx: 리턴스윕 속도 (px/ms, 음수)
    _onPang(lineIdx, vx) {
        MemoryLogger.info('PANG',
            `✅ Line ${lineIdx} complete | vx=${vx.toFixed(3)} px/ms`);
        MemoryLogger.snapshot(`PANG_L${lineIdx}`);

        // ── 텍스트 트레인 비주얼 ──────────────────────────────────
        // pang 시점(줄 완료)에만 DOM 업데이트 → 30Hz 쓰기 없음 (iOS 안전)
        // 읽은 줄: 페이드아웃 | 아직 안 읽은 줄: 그대로 표시
        if (this._lineEls) {
            this._lineEls.forEach((el, i) => {
                if (i < lineIdx) {
                    // 이미 읽고 지나간 줄 → 완전히 사라짐
                    if (el.style.opacity !== '0') el.style.opacity = '0';
                } else if (i === lineIdx) {
                    // 방금 완료된 줄 → 희미하게 잔상
                    if (el.style.opacity !== '0.15') el.style.opacity = '0.15';
                }
                // i > lineIdx: 아직 안 읽은 줄 → 변경 없음 (opacity 1.0 유지)
            });
        }

        // ── 줄 끝 팡 이펙트 ─────────────────────────────────────
        this._triggerLineEffect(lineIdx);
    }

    // 줄 완료 시각 이펙트 — CSS @keyframes + this._lineEls 캐시 사용
    // querySelectorAll 호출 없음 (iOS DOM 접근 최소화)
    // 생성 후 700ms 뒤 자동 DOM 제거 → 메모리 잔류 없음
    _triggerLineEffect(lineIdx) {
        // this._lineEls 캐시 사용 → querySelectorAll 없음
        if (!this._lineEls || !this._lineEls[lineIdx]) return;

        const r = this._lineEls[lineIdx].getBoundingClientRect();
        const el = document.createElement('div');
        el.className = 'pang-fx';
        el.style.cssText =
            `position:fixed;` +
            `top:${(r.top + r.height * 0.3).toFixed(0)}px;` +
            `left:${r.right.toFixed(0)}px;` +
            `pointer-events:none;font-size:20px;`;
        el.textContent = '✨';
        document.body.appendChild(el);
        setTimeout(() => { if (el.parentNode) el.remove(); }, 700);
    }

    // ── 재시작 ───────────────────────────────────────────────────
    restart() {
        MemoryLogger.info('GAME', '=== Game Restart ===');
        this.passageIndex = 0;
        this.score = 0;
        this.totalQuestions = 0;
        this._gazeActive = false;
        this._stopGazeDot();
        document.getElementById('btn-retry').style.display = 'none';
        this.start();
    }
}

// ── 게임 인스턴스 즉시 생성 ─────────────────────────────────────
// 주의: game.js는 <script type="module"> 내 loadScript()로 동적 로드됨.
// DOMContentLoaded는 모듈 실행 전에 이미 발화 → addEventListener('DOMContentLoaded') 사용 불가.
// DOM은 이미 완성된 상태이므로 즉시 실행.
(function initGame() {
    const game = new Game();
    window.__game = game;
    MemoryLogger.info('GAME', 'Game instance created, binding buttons...');

    // 시작 버튼
    const btnStart = document.getElementById('btn-start');
    if (btnStart) btnStart.addEventListener('click', () => game.start());
    else MemoryLogger.warn('GAME', '#btn-start not found in DOM');

    // 재시도 버튼
    const btnRetry = document.getElementById('btn-retry');
    if (btnRetry) btnRetry.addEventListener('click', () => game.restart());

    // 퀴즈 이동 버튼 (리딩 → 퀴즈)
    const btnQuiz = document.getElementById('btn-go-quiz');
    if (btnQuiz) btnQuiz.addEventListener('click', () => game.showQuiz());

    // 다시하기 버튼 (결과 → 처음)
    const btnPlayAgain = document.getElementById('btn-play-again');
    if (btnPlayAgain) btnPlayAgain.addEventListener('click', () => {
        game.passageIndex = 0;
        game.score = 0;
        game.totalQuestions = 0;
        game.setState('IDLE');
    });

    // 로그 다운로드 버튼
    const btnLog = document.getElementById('btn-download-log');
    if (btnLog) btnLog.addEventListener('click', () => MemoryLogger.downloadLogs());

    window.addEventListener('resize', () => {
        const canvas = document.getElementById('gaze-canvas');
        if (canvas) {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
        }
    });

    MemoryLogger.info('GAME', 'All buttons bound. Ready.');
})();
