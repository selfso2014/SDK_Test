import Seeso, { InitializationErrorType, CalibrationAccuracyCriteria } from './dist/seeso';

class EasySeeso {
  constructor() {
    this.seeso = new Seeso();
    this.onGaze = null;
    this.onFace = null;
    this.onDebug = null;
    // calibration
    this.onCalibrationNextPoint = null;
    this.onCalibrationProgress = null;
    this.onCalibrationFinished = null;
    // user status
    this.onAttention = null;
    this.onBlink = null;
    this.onDrowsiness = null;

    this.onGazeBind = null;
    this.onCalibrationFinishedBind = null;
  }

  async init(licenseKey, afterInitialized, afterFailed, userStatusOption) {
    await this.seeso.initialize(licenseKey, userStatusOption).then(function (errCode) {
      if (errCode === InitializationErrorType.ERROR_NONE) {
        afterInitialized();
        this.onCalibrationFinishedBind = this.onCalibrationFinished_.bind(this);
        this.seeso.addCalibrationFinishCallback(this.onCalibrationFinishedBind);
        this.onGazeBind = this.onGaze_.bind(this);
        this.seeso.addGazeCallback(this.onGazeBind);
      } else {
        afterFailed();
      }
    }.bind(this));
  }

  deinit() {
    this.removeUserStatusCallback();
    this.seeso.removeGazeCallback(this.onGazeBind);
    this.seeso.removeCalibrationFinishCallback(this.onCalibrationFinishedBind);
    this.seeso.removeDebugCallback(this.onDebug);
    this.seeso.deinitialize();
  }

  async startTracking(onGaze, onDebug) {
    // [FIX-iOS] 전면 카메라 + 해상도 제한 (iPhone 후면 카메라 / 12MP 방지)
    // {'video': true}는 iOS에서 후면 카메라 or 최대 해상도 → WASM 검은 프레임
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const videoConstraints = isIOS ? {
      facingMode: { ideal: 'user' },   // 전면 카메라 우선 (eye tracking 필수)
      width: { ideal: 640, max: 1280 }, // 해상도 제한 → WASM 처리 가능
      height: { ideal: 480, max: 720 },
      frameRate: { max: 30 }             // 30fps 이하 제한
    } : { facingMode: 'user' };          // PC도 전면 카메라 명시

    const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints });

    // [FIX-iOS] SDK video element에 playsinline 강제 추가
    // playsinline 없으면 iOS Safari가 fullscreen 시도 → grabFrame 검은 프레임
    if (isIOS) {
      stream.getVideoTracks().forEach(track => {
        const settings = track.getSettings();
        console.log('[EasySeeso] Camera:', settings.facingMode, settings.width + 'x' + settings.height, settings.frameRate + 'fps');
      });
    }

    this.seeso.addDebugCallback(onDebug);
    if (this.seeso.startTracking(stream)) {
      this.onGaze = onGaze;
      this.onDebug = onDebug;
      return true;
    } else {
      this.seeso.removeDebugCallback(this.onDebug);
      return false;
    }
  }


  stopTracking() {
    this.seeso.stopTracking();
    this.seeso.removeDebugCallback(this.onDebug);
    this.onGaze = null;
    this.onDebug = null;
  }

  setFaceCallback(onFace) {
    this.seeso.addFaceCallback(onFace);
    this.onFace = onFace;
  }

  removeFaceCallbck(onFace) {
    this.seeso.removeFaceCallbck(onFace);
  }

  setScreenSize(widthMm, heightMm) {
    if (widthMm && widthMm > 0 && heightMm && heightMm > 0) {
      this.seeso.setScreenSize(widthMm, heightMm)
    }
  }

  setUserStatusCallback(onAttention, onBlink, onDrowsiness) {
    this.seeso.addAttentionCallback(onAttention);
    this.seeso.addBlinkCallback(onBlink);
    this.seeso.addDrowsinessCallback(onDrowsiness);
    this.onAttention = onAttention;
    this.onBlink = onBlink;
    this.onDrowsiness = onDrowsiness;
  }

  removeUserStatusCallback() {
    this.seeso.removeAttentionCallback(this.onAttention);
    this.seeso.removeBlinkCallback(this.onBlink);
    this.seeso.removeDrowsinessCallback(this.onDrowsiness);
  }

  startCalibration(onCalibrationNextPoint, onCalibrationProgress, onCalibrationFinished, calibrationPoints = 5) {
    this.seeso.addCalibrationNextPointCallback(onCalibrationNextPoint);
    this.seeso.addCalibrationProgressCallback(onCalibrationProgress);
    const isStart = this.seeso.startCalibration(calibrationPoints, CalibrationAccuracyCriteria.Default);
    if (isStart) {
      this.onCalibrationNextPoint = onCalibrationNextPoint;
      this.onCalibrationProgress = onCalibrationProgress;
      this.onCalibrationFinished = onCalibrationFinished;
    } else {
      this.seeso.removeCalibrationNextPointCallback(this.onCalibrationNextPoint);
      this.seeso.removeCalibrationProgressCallback(this.onCalibrationProgress);
    }
    return isStart;
  }

  stopCalibration() {
    return this.seeso.stopCalibration();
  }

  setTrackingFps(fps) {
    this.seeso.setTrackingFps(fps);
  }

  async fetchCalibrationData(userId) {
    return this.seeso.fetchCalibrationData(userId);
  }

  async uploadCalibrationData(userId) {
    return this.seeso.uploadCalibrationData(userId);
  }

  showImage() {
    this.seeso.showImage();
  }

  hideImage() {
    this.seeso.hideImage();
  }

  startCollectSamples() {
    this.seeso.startCollectSamples();
  }

  checkMobile() {
    return this.seeso.checkMobile();
  }

  setMonitorSize(monitorInch) {
    this.seeso.setMonitorSize(monitorInch);
  }

  setFaceDistance(faceDistance) {
    this.seeso.setFaceDistance(faceDistance);
  }

  setCameraPosition(cameraX, cameraOnTop) {
    this.seeso.setCameraPosition(cameraX, cameraOnTop);
  }

  setCameraConfiguration(cameraConfig) {
    this.seeso.setCameraConfiguration(cameraConfig)
  }

  getCameraConfiguration() {
    this.seeso.getCameraConfiguration()
  }

  getCameraPosition() {
    return this.seeso.getCameraPosition();
  }

  getFaceDistance() {
    return this.seeso.getFaceDistance();
  }

  getMonitorSize() {
    return this.seeso.getMonitorSize();
  }

  async setCalibrationData(calibrationDataString) {
    await this.seeso.setCalibrationData(calibrationDataString);
  }

  static openCalibrationPage(licenseKey, userId, redirectUrl, calibraitonPoint) {
    Seeso.openCalibrationPage(licenseKey, userId, redirectUrl, calibraitonPoint)
  }

  static openCalibrationPageQuickStart(licenseKey, userId, redirectUrl, calibraitonPoint) {
    Seeso.openCalibrationPageQuickStart(licenseKey, userId, redirectUrl, calibraitonPoint);
  }

  setAttentionInterval(interval) {
    this.seeso.setAttentionInterval(interval);
  }

  getAttentionScore() {
    return this.seeso.getAttentionScore();
  }

  static getVersionName() {
    return Seeso.getVersionName();
  }
  /**
   * For type hinting
   * @private
   * @param {GazeInfo} gazeInfo
   */
  onGaze_(gazeInfo) {
    if (this.onGaze) this.onGaze(gazeInfo);
  }

  /**
   * For remove callback
   * @private
   */
  onCalibrationFinished_(calibrationData) {
    if (this.onCalibrationFinished) {
      this.onCalibrationFinished(calibrationData);
    }
    this.seeso.removeCalibrationNextPointCallback(this.onCalibrationNextPoint);
    this.seeso.removeCalibrationProgressCallback(this.onCalibrationProgress);
    this.onCalibrationFinished = null;
    this.onCalibrationProgress = null;
    this.onCalibrationNextPoint = null;
  }
}

export default EasySeeso;
