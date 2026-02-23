/**
 * seeso-bridge.js
 * seeso.min.js (ESM)를 동적 import하여 window에 전역 노출.
 * easy-seeso.js가 './dist/seeso' (확장자 없음)를 import하면 브라우저가 404를 반환하므로
 * 이 브릿지를 통해 window.EasySeeso를 우회하여 등록한다.
 *
 * 호출 방법: await window.__seesoReady
 */
window.__seesoReady = (async () => {
    try {
        // seeso.min.js는 ESM → type="module" 컨텍스트에서만 import 가능
        // 확장자 포함 경로로 직접 import
        const mod = await import('./dist/seeso.min.js');

        // seeso.min.js가 export default Seeso 형태로 내보내는 경우
        const SeesoClass = mod.default || mod.Seeso || mod;
        window.__SeesoCore = SeesoClass;
        window.__InitializationErrorType = mod.InitializationErrorType;
        window.__CalibrationAccuracyCriteria = mod.CalibrationAccuracyCriteria;

        MemoryLogger.info('BRIDGE', 'seeso.min.js loaded via ESM import ✅', {
            hasDefault: !!mod.default,
            exportKeys: Object.keys(mod).slice(0, 10),
        });
        return true;
    } catch (e) {
        MemoryLogger.error('BRIDGE', 'seeso.min.js ESM import FAILED', { msg: e.message });
        return false;
    }
})();
