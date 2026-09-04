# BARSA SHOPI v9.0 — FINAL MASTER REPORT

**الحالة:** Final Source Candidate قبل بناء APK واختبار الهاتف الحقيقي  
**الإصدار:** 9.0.0  
**Android versionCode:** 90  
**الهدف الأساسي:** تطبيق Android احترافي لتحسين الفيديو بالذكاء الاصطناعي، مع رندر Frame-Perfect، Blur مستقل، وحماية قوية من الانهيار.

---

## 1. الخلاصة التنفيذية

BARSA SHOPI v9.0 يجمع كل مراحل المشروع السابقة في مسار واحد مرتب بدل تكديس مزايا غير مترابطة. الواجهة الرئيسية مقسمة إلى أربع مساحات فقط: **الاستوديو، التحسين، البلور، التصدير**. الخيارات المتقدمة باقية لكنها مطوية/منظمة، بينما الرندر النهائي يحافظ على سياسة صارمة: **لا إسقاط فريمات بصمت، لا تغيير دقة أو FPS لتسريع وهمي، ولا تبديل نموذج AI مختار يدوياً بنموذج آخر أثناء الرندر.**

هذه النسخة هي المرشح النهائي للسورس قبل مرحلة بناء APK على GitHub Actions ثم الاختبار الفعلي على POCO F6.

---

## 2. مخطط التطبيق

```text
┌──────────────────────────────────────────────────────────────────────┐
│                         BARSA SHOPI v9.0                            │
│               Android WebView + Native ONNX Runtime                │
└─────────────────────────────────┬────────────────────────────────────┘
                                  │
                 ┌────────────────▼────────────────┐
                 │  1) الاستوديو / مصدر الفيديو  │
                 │ MediaInputEngine + Probe       │
                 │ MP4/WebM metadata + Audio      │
                 └────────────────┬────────────────┘
                                  │
                 ┌────────────────▼────────────────┐
                 │ Frame Integrity Guard           │
                 │ timestamps / gaps / ordering   │
                 └────────────────┬────────────────┘
                                  │
            ┌─────────────────────▼─────────────────────┐
            │              2) التحسين                  │
            │                                         │
            │ Temporal Reconstruction / Stabilization │
            │ Denoise / Compression Rescue / Detail   │
            │ Upscale AI: Native → WebGPU → WASM     │
            │ Face AI: YuNet + GFPGAN/CodeFormer     │
            │ RIFE: Native → WebGPU → WASM           │
            │ Color: RGB Mixer / Curves / LUT        │
            └─────────────────────┬─────────────────────┘
                                  │
                 ┌────────────────▼────────────────┐
                 │ Frame Sequencer / CFR Timeline │
                 │ no silent frame skipping       │
                 └───────────────┬─────────────────┘
                                 │
                 ┌───────────────▼─────────────────┐
                 │ 3) BLUR COMPLETE (اختياري)    │
                 │ f0e/blur concepts + RIFE       │
                 │ weighting / gamma / dedupe     │
                 │ Dedicated Blur-only render     │
                 └───────────────┬─────────────────┘
                                 │
                 ┌───────────────▼─────────────────┐
                 │ WebCodecs H.264 Encoder        │
                 │ Encoder Back-pressure          │
                 └───────────────┬─────────────────┘
                                 │
                 ┌───────────────▼─────────────────┐
                 │ OPFS Durable Elementary Stream │
                 │ Write Back-pressure            │
                 └───────────────┬─────────────────┘
                                 │
           ┌─────────────────────▼──────────────────────┐
           │ 4) MP4 Finalization                       │
           │ Native MP4 + AAC                          │
           │ fallback: FFmpeg H.264/AAC remux          │
           │ Fast Start + MP4 validation + A/V sync   │
           └─────────────────────┬──────────────────────┘
                                 │
                 ┌───────────────▼─────────────────┐
                 │ Render Proof / Safety Report   │
                 │ frame counts / backend / sync │
                 └───────────────┬─────────────────┘
                                 │
                 ┌───────────────▼─────────────────┐
                 │ Android MediaStore / Gallery   │
                 └─────────────────────────────────┘
```

### مسار الحماية الموازي

```text
RenderLoadGovernor + RenderResilienceEngine + DeviceGuard
                    │
                    ├─ يقلل concurrency عند الضغط
                    ├─ يقلل encoder queue
                    ├─ يقلل OPFS write backlog
                    ├─ يعمل yield دوري للواجهة
                    ├─ يسجل backend fallback
                    └─ لا يطلب إسقاط فريم أو تغيير output
```

---

## 3. تنظيم الواجهة النهائي

### الاستوديو
- اختيار الفيديو وتغييره.
- معلومات المصدر: الدقة، المدة، FPS، codec، HDR/VFR عند توفرها.
- Preview قبل/بعد.
- الدقة ونسبة الأبعاد وFit mode.
- إعداد الجهاز والأداء.
- الوصول إلى مركز النماذج وفحص الجهاز.

### التحسين
- All Engine Boost لتقوية المحركات دفعة واحدة بدون تغيير النموذج المختار.
- Quality Lab المتقدم مطوي افتراضياً لتقليل الزحام.
- Restore / Detail / Clarity / Sharpen / Stability.
- Temporal Reconstruction.
- Stabilization.
- Face / Portrait.
- Color / Curves / LUT / RGB Mixer.

### البلور
- مساحة مستقلة كاملة.
- إعدادات مبنية على مفاهيم `f0e/blur` الرسمية.
- Blur Amount / Shutter Angle / Output FPS.
- Weighting families.
- Gamma وGaussian advanced.
- RIFE interpolation وpre-interpolation.
- Deduplicate range/threshold/method.
- فلاتر Blur الخاصة.
- GPU settings.
- import/export `blur.cfg`.
- زر **رندر البلور فقط MP4**.

### التصدير
- MP4 H.264 + AAC.
- Auto / Max / Custom bitrate.
- Hardware / Software / Auto encoder preference.
- Fast Start.
- MP4 structural validation.
- Track validation.
- A/V sync validation.
- تقرير سلامة الرندر.

---

## 4. حالة نماذج الذكاء الاصطناعي

| النموذج | الوظيفة | طريقة الاستخدام | التحقق قبل Ready |
|---|---|---|---|
| Mobile SR ×3 | رفع دقة سريع | ONNX | حجم/فتح/Inference |
| Real-ESRGAN ×4 | رفع دقة وجودة أعلى | Native Android أو WebGPU/WASM | حجم/SHA عند توفره/Inference |
| RIFE 4.9 | Interpolation | Native Android حتى حدود آمنة + Web fallback | ONNX + Inference |
| RIFE 4.7 | Interpolation بديل | Native/Web | ONNX + Inference |
| YuNet | اكتشاف الوجوه | ONNX | Signature + Inference |
| GFPGAN 1.4 | ترميم وجه قوي | Native Android + Web fallback | Signature + Inference |
| CodeFormer | ترميم وجه مع Fidelity | Native Android + Web fallback | Signature + Inference |

### قاعدة v9 المهمة
**اختيار النموذج أثناء الرندر يدوي 100%.**  
BARSA يمكنه تنزيل وفحص النماذج تلقائياً أثناء الخمول، لكنه لا يستبدل النموذج الذي اختاره المستخدم بنموذج آخر وقت الرندر. إذا النموذج المطلوب غير جاهز، يتوقف Preflight ويطلب تثبيته/اختياره بوضوح.

كذلك تم منع التنزيل التلقائي بالخلفية بمجرد اختيار فيديو أو أثناء الرندر حتى لا ينافس الرندر على RAM/CPU/OPFS.

---

## 5. Quality / Detail Pipeline

### Restore
- Denoise.
- Temporal Denoise.
- Deblock.
- Deband.
- Artifact Removal.
- Chroma Denoise V3.
- Mosquito Noise V3.
- Compression Recovery V3.

### Detail
- Detail Recovery.
- Fine Detail Recovery.
- Texture Recovery.
- Micro Texture V2.
- Structure Recovery V2.
- Detail Fusion V3.
- Edge Recovery.

### Clarity / Sharpness
- Clarity.
- Local Contrast.
- Smart Sharpen.
- Dehalo.
- Anti-Ringing.

### Temporal Stability
- Anti-Flicker.
- Temporal Detail Stability.
- Temporal Reconstruction متعدد الإطارات.
- Scene-cut protection.

هذه المراحل ليست مجرد أسماء UI؛ القيم تمر إلى مسار معالجة البكسلات/الزمن الفعلي، مع تجاوز المرحلة بالكامل عندما تكون مطفأة.

---

## 6. Face / Portrait Pipeline

1. YuNet يحدد منطقة الوجه.
2. tracking/stabilization للصناديق بين الفريمات.
3. GFPGAN أو CodeFormer حسب اختيار المستخدم.
4. local face finishing:
   - Face Detail.
   - Skin Cleanup.
   - Skin Smoothing.
   - Face Micro Contrast.
   - Skin Tone Protect.
   - Eye Detail V3.
   - Hair Detail V3.
5. الدمج يرجع داخل منطقة الوجه فقط.

Native Face له fallback آمن إلى WebGPU/WASM إذا الـprovider الأصلي لم يتوافق مع النموذج أو الجهاز.

---

## 7. Blur Complete

المرجع الصحيح: `https://github.com/f0e/blur?tab=readme-ov-file`

BARSA لا يشغل نسخة Windows/VapourSynth نفسها داخل Android؛ بل يطبق المفاهيم المطلوبة داخل محركه المحمول:
- frame weighting.
- gamma-aware temporal blend.
- RIFE interpolation.
- pre-interpolation.
- deduplicate.
- custom weighting.
- Gaussian parameters.
- final FPS مستقل عن internal interpolation FPS.

رندر Blur-only معزول فعلياً عن Upscale/Face/Quality/Color/Temporal Reconstruction/Stabilization، لذلك لا تختلط المعالجة عندما يريد المستخدم البلور وحده.

---

## 8. Frame-Perfect Render Contract

BARSA v9 يعتبر سلامة الإطارات جزءاً من نجاح الرندر، وليس مجرد معلومة.

الفحوصات:
- decoded frame count.
- processed source frame count.
- monotonic source timestamps.
- output timestamp monotonicity.
- output gaps.
- submitted encoder frames.
- written encoder packets.
- final output duration.

إذا حصل فقد أو اختلاف خطير، يفشل الرندر قبل تسليم MP4 بدلاً من تسليم فيديو ناقص بصمت.

### ملاحظة VFR
الفجوات المشروعة في timeline لمصدر VFR/edit lists لا تعتبر تلقائياً frame loss؛ الـCFR sequencer يملأ timeline المطلوب، بينما non-monotonic ordering يبقى خطأ صريحاً.

---

## 9. منع الانهيار والرندر الطويل

لا يوجد نموذج AI سحري لمنع الانهيار. الحماية الفعلية مبنية على هندسة الرندر:

- RenderLoadGovernor.
- RenderResilienceEngine.
- DeviceGuard.
- Encoder back-pressure.
- OPFS write back-pressure.
- Tile concurrency control.
- Periodic event-loop yields.
- FFmpeg lifecycle cleanup.
- Temporal/Stabilization reset بعد كل Job.
- Resilience diagnostics reset لكل Job في v9.
- Native → WebGPU → WASM fallback للمحركات المدعومة.
- Native MP4 failure → FFmpeg recovery من elementary stream بدل خسارة الرندر كله.
- AAC failure → FFmpeg audio remux fallback.
- terminal OPFS session cleanup.

### POCO F6 / 4K sustained policy
عند الحمل الثقيل لا يطلب النظام إسقاط فريمات أو تغيير resolution/FPS. يقلل فقط الـconcurrency والـqueues ويزيد checkpoints/yields.

---

## 10. Android Architecture

- Native Android WebView shell.
- Hardware accelerated layer.
- High renderer priority.
- Java 17.
- minSdk 29 / targetSdk 35 / compileSdk 35.
- ONNX Runtime Android 1.22.0.
- Native localhost bridge للـbinary model/tensor transport.
- MediaStore export إلى معرض الهاتف.
- Keep Screen On أثناء الرندر.
- Adaptive launcher icon.
- GitHub Debug workflow.
- GitHub Release workflow مع signing secrets اختيارياً.

الإصدار النهائي الحالي:
- `versionName 9.0.0`
- `versionCode 90`

---

## 11. التخزين والخصوصية

- الفيديو يبقى محلياً.
- OPFS يستخدم للـsource cache / elementary streams / temporary render data.
- model files محلية بعد التثبيت.
- لا يوجد رفع تلقائي للفيديو إلى خدمة سحابية.
- طلب persistent storage عند دعم النظام.
- تنظيف sessions المكتملة والملغاة لمنع تراكم المساحة.

---

## 12. نتيجة الاختبارات النهائية في بيئة هذه الجلسة

**Total tests: 152**  
**PASS: 149**  
**Environment-only failures: 3**

الثلاثة المتبقية مرتبطة بغياب dependencies في بيئة الجلسة:
1. `mediabunny` container probe.
2. NativeMP4Muxer browser dependency test.
3. StorageManager Playwright/browser test.

هذه ليست assertion failures من تعديلات v9. GitHub workflow يبدأ بـ `npm ci` قبل `npm test`، لذلك يجب إعادة تشغيل المجموعة الكاملة هناك قبل اعتبار APK Release ناجحاً.

اختبارات v9 الجديدة: **5/5 PASS**.

Audits:
- Source Policy: **PASS**.
- Final Audit: **PASS**.
- UI Audit: **PASS**.
- JavaScript syntax checks: **PASS**.
- 53 source modules audited.
- 14 critical runtime files audited.
- 150 statically referenced UI IDs resolved.
- 0 duplicate static HTML IDs.

---

## 13. التغييرات النهائية في v9 مقارنة بـ v8.8

1. إزالة `ModelAutoSelector` من `EngineManager` الإنتاجي حتى لا يبقى مسار داخلي يوحي باختيار تلقائي.
2. منع fallback إلى موديل مختلف في `validateEnabledModels()`؛ النموذج المختار يبقى هو المطلوب.
3. إذا الرندر يحتاج RIFE ولم يفعله المستخدم، يظهر خطأ واضح بدلاً من تشغيله وتحديده خفية.
4. تنزيل النماذج التلقائي يعمل بالخمول فقط عندما لا يوجد فيديو مختار ولا Job فعال.
5. منع Model Vault من البدء أثناء الرندر.
6. `RenderResilienceEngine.reset()` لكل Job حتى تقرير الرندر لا يحتوي أرقام Job سابق.
7. ترجمة مرحلة `render-plan` في واجهة تقدم الرندر.
8. Quality Lab المتقدم مطوي افتراضياً لتقليل زحمة الواجهة.
9. توحيد الإصدار إلى 9.0.0 / 90 في package/package-lock/Android/GitHub artifacts.
10. إضافة اختبارات v9 خاصة بهذه القواعد.

---

## 14. ما هو جاهز وما الذي يحتاج هاتفاً حقيقياً

### جاهز في السورس
- المعمارية.
- الواجهة.
- كل مسارات الرندر الأساسية.
- Frame integrity.
- native/web fallbacks.
- model verification logic.
- Blur-only pipeline.
- MP4 recovery.
- Android source.
- GitHub build workflows.

### لا يمكن إثباته 100% داخل هذه البيئة فقط
- حرارة POCO F6 بعد رندر 4K طويل.
- سرعة NNAPI الفعلية لكل model export.
- vendor-specific H.264 encoder behaviour على الجهاز.
- memory pressure الحقيقي للـWebView على MIUI/HyperOS.
- تشغيل جميع النماذج السبعة downloaded من الإنترنت في جلسة الهاتف نفسها.

هذه النقاط هي مرحلة **Device Acceptance Test**، وليست سبباً لإضافة Features جديدة للسورس الآن.

---

## 15. خطة تحويل السورس إلى تطبيق نهائي

1. رفع حزمة v9 إلى GitHub.
2. تشغيل `Android APK` workflow.
3. يجب أن يمر `npm ci → npm test → check → final:audit → build → Gradle`.
4. تثبيت Debug APK على POCO F6.
5. تشغيل Full Device Test من داخل التطبيق.
6. تنزيل وفحص النماذج السبعة.
7. اختبار فيديوهات حقيقية:
   - 1080p30.
   - 1080p60.
   - فيديو كرة/مونتاج سريع.
   - Blur-only.
   - RIFE ×2.
   - Face restore.
   - فيديو 4K قصير ثم رندر أطول.
8. مراجعة Render Proof لكل اختبار.
9. إذا كلها PASS، تشغيل Release workflow وتوقيع APK.

---

## 16. قرار الإصدار

**v9.0 هو Final Source Candidate.**  
من هذه النقطة لا أنصح بإضافة محركات أو خيارات جديدة قبل اختبار الهاتف؛ أي إضافة جديدة ستعيد فتح نطاق المخاطر. المرحلة التالية يجب أن تكون **بناء APK + Device Acceptance** ثم إصلاح المشاكل التي تظهر على الجهاز فقط.
