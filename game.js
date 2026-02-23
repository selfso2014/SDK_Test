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

        // ── 텍스트 트레인 상태 ──────────────────────────────────
        this._trainLines = [];       // [HTMLElement] 라인 div 목록
        this._trainCurrentLine = -1; // 현재 gaze가 있는 라인 인덱스
        this._trainReady = false;    // 라인 그룹화 완료 여부
        // ⚠️ 캐시: 렌더 시 1회만 측정 (반복 DOM 읽기 괈지)
        this._trainWrapTop = 0;      // wrap.getBoundingClientRect().top 케시
        this._trainLineH = 32;     // 라인 높이 케시 (px)

        // 캘리브레이션 UI
        this._calDotX = null;
        this._calDotY = null;
        this._calProgress = 0;
        this._calRafId = null;

        // gaze dot canvas
        this._gazeDotRafId = null;
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
        this._trainLines = [];
        this._trainCurrentLine = -1;
        this._trainReady = false;

        await this.setState('READING');
        this._gazeActive = true;
        this._startGazeDot();

        // 지문 렌더링 (텍스트 트레인)
        document.getElementById('reading-title').textContent = this.currentPassage.title;
        this._renderTextTrain(this.currentPassage.text);
        document.getElementById('status-text').textContent = '📖 지문을 읽어주세요';
    }

    // ── 퀴즈 화면 ────────────────────────────────────────────────
    async showQuiz() {
        if (!this.currentPassage) return;

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

        // READING 상태에서만 데이터 수집 + 텍스트 트레인 업데이트
        if (this.state === 'READING') {
            // TypedArray 순환버퍼에 쓰기 (GC 없음)
            this._gx[this._gIdx] = gazeInfo.x;
            this._gy[this._gIdx] = gazeInfo.y;
            this._gt[this._gIdx] = Date.now();
            this._gIdx = (this._gIdx + 1) % MAX_GAZE_ENTRIES;
            if (this._gCount < MAX_GAZE_ENTRIES) this._gCount++;

            // 텍스트 트레인 업데이트
            if (this._trainReady) this._updateTextTrain(gazeInfo.y);
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

    // ── 텍스트 트레인 ────────────────────────────────────────────
    // 텍스트를 단어 span으로 임시 렌더 → offsetTop으로 라인 감지
    // → 라인 div로 재구성 → gaze Y 기반 fade-out
    _renderTextTrain(text) {
        const container = document.getElementById('reading-text');
        container.innerHTML = '';

        // 1단계: 단어 span으로 임시 렌더 (offsetTop 측정용)
        const tokens = text.split(/(\s+)/);
        tokens.forEach(token => {
            const span = document.createElement('span');
            span.style.display = 'inline';
            span.textContent = token;
            container.appendChild(span);
        });

        // 2단계: 레이아웃 완료 후 라인 그룹화 → 라인 div로 재구성
        // 150ms 대기: iOS에서 레이아웃 계산 완료 보장
        setTimeout(() => {
            const spans = Array.from(container.querySelectorAll('span'));
            const lineMap = new Map(); // offsetTop → 텍스트 토큰 배열

            spans.forEach(span => {
                const top = span.offsetTop;
                if (!lineMap.has(top)) lineMap.set(top, []);
                lineMap.get(top).push(span.textContent);
            });

            // 3단계: 라인 div로 재구성 (CSS transition은 라인 단위 적용 = 성능 최적화)
            container.innerHTML = '';
            this._trainLines = [];

            Array.from(lineMap.entries())
                .sort((a, b) => a[0] - b[0])
                .forEach(([_, tokens]) => {
                    const lineDiv = document.createElement('div');
                    lineDiv.className = 'text-line';
                    lineDiv.textContent = tokens.join('');
                    container.appendChild(lineDiv);
                    this._trainLines.push(lineDiv);
                });

            MemoryLogger.info('GAME',
                `TextTrain built: ${this._trainLines.length} lines`);

            // ⚠️ 핀 포인트: getBoundingClientRect/offsetTop을 여기서 1회만 케시
            // _updateTextTrain이 30Hz로 호출되므로 DOM 읽기는 절대 금지
            const wrap = document.getElementById('reading-text-wrap');
            if (wrap) {
                this._trainWrapTop = wrap.getBoundingClientRect().top;
                this._trainLineH = this._trainLines.length > 1
                    ? (this._trainLines[1].offsetTop - this._trainLines[0].offsetTop)
                    : 32;
                MemoryLogger.info('GAME',
                    `TextTrain cache: wrapTop=${this._trainWrapTop.toFixed(0)} lineH=${this._trainLineH.toFixed(0)}`);
            }
            this._trainReady = true;
        }, 150);
    }

    // gaze Y(스크린 좌표) → 현재 라인 인덱스 → 2줄 이상 뒤 fade-out
    // ⚠️ 핸 포인트: DOM 읽기 없음 (모두 케시된 값 사용)
    _updateTextTrain(gazeY) {
        if (!this._trainLines.length) return;

        // 캐시된 값만 사용 → 순수 산술, DOM 읽기 없음
        const relY = gazeY - this._trainWrapTop;
        if (relY < 0) return;

        const gazeLine = Math.max(0, Math.min(
            Math.floor(relY / this._trainLineH),
            this._trainLines.length - 1
        ));

        // 라인이 변경될 때만 실행 (단방향)
        if (gazeLine <= this._trainCurrentLine) return;
        this._trainCurrentLine = gazeLine;

        this._trainLines.forEach((lineDiv, i) => {
            const diff = this._trainCurrentLine - i;
            const next = diff <= 0 ? '1' : diff === 1 ? '0.2' : '0';
            // 실제 변경시에만 쓰기 (redundant style write 방지)
            if (lineDiv.dataset.op !== next) {
                lineDiv.style.opacity = next;
                lineDiv.dataset.op = next;
            }
        });
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
