/**
 * game.js
 * 게임 메인 상태 머신 컨트롤러
 *
 * 상태 흐름:
 * IDLE → SDK_INIT → CALIBRATION → READING → QUIZ → RESULT
 * (startTracking은 SDK_INIT 직후, 내부에서 getUserMedia 처리)
 */

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

        const dot = document.getElementById('cal-dot');
        if (dot) {
            dot.style.left = (x - 30) + 'px';
            dot.style.top = (y - 30) + 'px';
            dot.style.display = 'block';
            // 반짝이는 애니메이션 재시작
            dot.classList.remove('pulse');
            void dot.offsetWidth; // reflow
            dot.classList.add('pulse');
        }

        document.getElementById('status-text').textContent =
            `🎯 이 점을 바라봐 주세요 (${Math.round(x)}, ${Math.round(y)})`;
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

        await this.setState('READING');
        this._gazeActive = true;
        this._startGazeDot();

        // 지문 렌더링
        document.getElementById('reading-title').textContent = this.currentPassage.title;
        document.getElementById('reading-text').textContent = this.currentPassage.text;
        document.getElementById('status-text').textContent = '📖 지문을 읽어주세요';
    }

    // ── 퀴즈 화면 ────────────────────────────────────────────────
    async showQuiz() {
        if (!this.currentPassage) return;

        await this.setState('QUIZ');
        this._gazeActive = true;

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
    }

    // ── 시선 콜백 ────────────────────────────────────────────────
    _onGaze(gazeInfo) {
        if (!gazeInfo) return;
        this._gazeX = gazeInfo.x;
        this._gazeY = gazeInfo.y;
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

        const draw = () => {
            if (!this._gazeActive) return;
            this._gazeDotRafId = requestAnimationFrame(draw);

            const ctx = canvas.getContext('2d');
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
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
