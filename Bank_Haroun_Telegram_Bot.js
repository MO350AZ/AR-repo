/**
 * ============================================================================
 * 🏦 بوت تيليجرام لفحص وإصلاح ملفات حفظ بنك هارون (Bank Haroun Save Doctor Bot)
 * الإصدار: v3.2 (متوافق 100% مع بصمة اللعبة الرسمية + حل جذري لمشكلة السيولة غير الكافية)
 * ============================================================================
 *
 * المميزات:
 * 1. يعمل بدون أي مكتبات خارجية (Zero Dependencies) — يستخدم مكتبات Node.js المدمجة فقط.
 * 2. يعمل محلياً على الكمبيوتر (Long Polling) وبنفس الكود يعمل على السيرفرات المجانية (Render / Railway / Koyeb).
 * 3. يفحص ملفات (.haroun / .json) ويكتشف ويعالج:
 *    - مشكلة «السيولة غير كافية» في الاستثمار رغم ظهور السيولة في البنك:
 *      * يعالج انخفاض openingCash في dayCashCheckpoints (مثل توقفها عند 179,200 ج.م بينما السيولة 2,410,784 ج.م).
 *      * يضبط betweenDayDelta و closingCash ويزيل الكسور العشرية (.5 / .8) من أرصدة البداية.
 *      * يرفع مؤشر تقدم المزامنة (storyIndex + 2) و (saveRevision + 15) لتخطي قفل "review" وإجبار السيرفر على اعتماد السيولة الكاملة.
 *    - تلف بصمة الأمان (SHA-256 Checksum) بمعادلة اللعبة الرسمية المباشرة JSON.stringify(a).
 *    - نقص أو تعارض إيصالات شراء ماكينات الصراف الآلي (ATM Ownership & Receipts).
 * 4. يعرض 6 أزرار تفاعلية (Inline Keyboard) داخل تيليجرام لاختيار نوع الإصلاح ويرسل الملف السليم فوراً.
 *
 * طريقة التشغيل السريعة على الكمبيوتر:
 * 1. ثبّت Node.js (الإصدار 18 أو أحدث) من https://nodejs.org
 * 2. ضع توكن البوت من @BotFather في المتغير BOT_TOKEN بالأسفل (أو في متغير البيئة BOT_TOKEN)
 * 3. شغّل الأمر:
 *    node bank_haroun_telegram_bot.js
 * ============================================================================
 */

const https = require("https");
const http = require("http");
const crypto = require("crypto");

// ضع توكن البوت الخاص بك هنا من @BotFather أو مرره عبر متغير البيئة BOT_TOKEN
const BOT_TOKEN = process.env.BOT_TOKEN || "PUT_YOUR_TELEGRAM_BOT_TOKEN_HERE";
const PORT = Number(process.env.PORT || 3000);
const WEBHOOK_URL = process.env.WEBHOOK_URL || ""; // اختياري للسيرفرات السحابية

// مواقع ماكينات الصراف الآلي المعتمدة في اللعبة
const VALID_ATM_SITES = new Set(["republic", "canal", "garden", "ferry", "university"]);
const ATM_RECEIPT_REGEX = /^ATM-LOCAL-\d+-\d+-\d+$/;

// ذاكرة مؤقتة لحفظ آخر ملف أرسله كل مستخدم لتطبيق الأزرار التفاعلية عليه
// Map<chatId, { fileName: string, rawText: string, uploadedAt: number }>
const userSessions = new Map();

// تنظيف الجلسات القديمة كل 30 دقيقة لتوفير الذاكرة
setInterval(() => {
  const now = Date.now();
  for (const [chatId, session] of userSessions.entries()) {
    if (now - session.uploadedAt > 60 * 60 * 1000) {
      userSessions.delete(chatId);
    }
  }
}, 30 * 60 * 1000);

// ============================================================================
// 1. دوال فحص وإصلاح ملف حفظ بنك هارون (مطابقة لكود اللعبة 1.69.369+)
// ============================================================================

/**
 * بناء الكائن الرسمي وحساب بصمة SHA-256 بنفس دالة vu.inspectSerialized داخل اللعبة
 * (باستخدام JSON.stringify المباشر بدون ترتيب أبجدي للمفاتيح)
 */
function buildCanonicalEnvelope(saveObj) {
  const payload = saveObj.payload || {};
  const envelope = {
    format: "bank-haroun-save",
    saveVersion: Number.isFinite(Number(saveObj.saveVersion)) ? Number(saveObj.saveVersion) : 1,
    gameVersion: String(saveObj.gameVersion || "1.69.389"),
    createdAt: String(saveObj.createdAt || new Date().toISOString()),
    completedDay: Math.max(0, Math.floor(Number(saveObj.completedDay) || 0)),
    currentDay: Math.max(1, Math.floor(Number(saveObj.currentDay) || Number(payload.day) || 1)),
    saveRevision: Math.max(0, Math.floor(Number(saveObj.saveRevision) || Number(payload.saveRevision) || 0)),
    updatedAt: Math.max(0, Math.floor(Number(saveObj.updatedAt) || Number(payload.lastSavedAt) || Date.now())),
    payload: payload
  };
  const serialized = JSON.stringify(envelope);
  const checksum = crypto.createHash("sha256").update(Buffer.from(serialized, "utf8")).digest("hex");
  return { envelope, checksum };
}

/**
 * حساب اليوم الفعلي المعروض للاعب (مثل اليوم 59..63 عندما يكون day الداخلي = 44)
 */
function getPublicDay(payload) {
  if (!payload || typeof payload !== "object") return 1;
  const d = Math.max(1, Math.floor(Number(payload.day) || 1));
  if (d === 44) {
    if (payload.daySixtyTwoStarted) {
      return Math.max(62, Math.min(75, Math.floor(Number(payload.daySixtyTwoDay) || 62)));
    }
    if (payload.daySixtyOneStarted) return 61;
    if (payload.daySixtyStarted) return 60;
    if (payload.dayFiftyNineStarted) return 59;
    return 58;
  }
  if (d === 43) return 57;
  return d;
}

/**
 * التحقق مما إذا كانت الحركة في السجل عبارة عن إيصال شراء ماكينة ATM رسمي (-2,000,000)
 */
function isAtmPurchaseEntry(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (!ATM_RECEIPT_REGEX.test(String(entry.id || ""))) return false;
  if (Number(entry.amount) !== -2000000) return false;
  if (entry.atmOperation !== undefined) {
    return entry.atmOperation === "purchase" && VALID_ATM_SITES.has(entry.atmSiteId);
  }
  return /^حركة شبكة ماكينات بنك هارون: (?:تم إرسال طلب التركيب|تم شراء الماكينة)/.test(String(entry.label || ""));
}

/**
 * تطبيق الإصلاح العميق لمشكلة «السيولة غير الكافية» في الاستثمار والمزامنة السحابية
 */
function applyDeepLiquidityFix(p, options = { refundActiveInvestments: false }) {
  const logs = [];
  if (!p || typeof p !== "object") return logs;

  // 1. إذا طلب المستخدم استرداد الاستثمارات النشطة المعلقة في السجل إلى سيولة البنك
  if (options.refundActiveInvestments && Array.isArray(p.ledger)) {
    const activeMap = new Map();
    for (const item of p.ledger) {
      const idStr = String(item?.id || "");
      if (idStr.startsWith("ASSOC-INV-S-")) {
        const key = idStr.slice("ASSOC-INV-S-".length);
        activeMap.set(key, { idStr, amount: Math.abs(Math.round(Number(item.amount) || 0)), label: item.label });
      } else if (idStr.startsWith("ASSOC-INV-W-S-") || idStr.startsWith("ASSOC-INV-C-S-")) {
        const key = idStr.replace(/^ASSOC-INV-[WC]-S-/, "");
        activeMap.delete(key);
      }
    }
    for (const [key, inv] of activeMap.entries()) {
      if (inv.amount > 0) {
        const refundId = `ASSOC-INV-W-S-${key}`;
        if (!p.ledger.some(e => e && e.id === refundId)) {
          p.ledger.push({
            id: refundId,
            amount: inv.amount,
            label: String(inv.label || "").replace("استثمار هارون:", "سحب استثمار:") || "سحب استثمار مسترد"
          });
          if (p.ledger.length > 520) {
            p.ledger = p.ledger.slice(-520);
          }
          p.cash = Math.round((Number(p.cash) || 0) + inv.amount);
          logs.push(`استرداد مبلغ الاستثمار النشط (${inv.amount.toLocaleString("en-US")} ج.م) وإضافته لسيولة البنك.`);
        }
      }
    }
  }

  // 2. تقريب السيولة الحالية إلى عدد صحيح نظيف (بدون كسور قروش تعطل فحص Number.isSafeInteger)
  const cleanCash = Math.max(0, Math.round(Number(p.cash) || 0));
  if (p.cash !== cleanCash) {
    logs.push(`تصحيح كسور السيولة من ${p.cash} إلى عدد صحيح (${cleanCash.toLocaleString("en-US")} ج.م).`);
  }
  p.cash = cleanCash;

  // 3. تقريب أرصدة بداية الأيام من أي كسور عشرية (مثل daySixtyTwoStartCash: 644082.5)
  for (const [k, v] of Object.entries(p)) {
    if (/^day.*StartCash$/.test(k) && typeof v === "number" && Number.isFinite(v)) {
      const rounded = Math.round(v);
      if (rounded !== v) {
        p[k] = rounded;
        logs.push(`إزالة الكسر العشري من ${k} (${v} ⬅ ${rounded.toLocaleString("en-US")}).`);
      }
    }
  }

  // 4. إصلاح فجوة dayCashCheckpoints[day] (السبب الرئيسي لرفض المبالغ الأكبر من openingCash مثل 179,200 ج.م!)
  const dayNum = Math.max(1, Math.min(44, Math.floor(Number(p.day) || 1)));
  const dayKey = String(dayNum);
  if (!p.dayCashCheckpoints || typeof p.dayCashCheckpoints !== "object") {
    p.dayCashCheckpoints = {};
  }
  const cp = p.dayCashCheckpoints[dayKey] || {
    day: dayNum,
    betweenDayDelta: 0,
    guardCorrection: 0,
    previousClosingCash: cleanCash,
    openingCash: cleanCash,
    closingCash: cleanCash
  };

  const oldOpening = Number(cp.openingCash) || 0;
  const oldClosing = Number(cp.closingCash) || 0;
  const prevDayCp = p.dayCashCheckpoints[String(dayNum - 1)];
  const prevClosing = (prevDayCp && Number.isFinite(Number(prevDayCp.closingCash)))
    ? Math.round(Number(prevDayCp.closingCash))
    : Math.round(Number(cp.previousClosingCash) || cleanCash);

  cp.previousClosingCash = prevClosing;
  cp.closingCash = cleanCash;
  cp.guardCorrection = 0;

  // إذا كان اليوم مكتملاً أو كانت openingCash أقل من السيولة الحالية (بسبب إيرادات CORP-CONV و ATM-LOCAL)،
  // نرفع openingCash و betweenDayDelta لتطابق السيولة الحالية حتى لا يصبح الرصيد سالباً عند خصم الاستثمار!
  if (String(p.phase || "").endsWith("-complete") || oldOpening < cleanCash) {
    cp.openingCash = cleanCash;
    cp.betweenDayDelta = cleanCash - prevClosing;
  } else {
    cp.openingCash = Math.round(oldOpening);
    cp.betweenDayDelta = Math.round(Number(cp.betweenDayDelta) || 0);
  }
  p.dayCashCheckpoints[dayKey] = cp;

  if (oldOpening !== cp.openingCash || oldClosing !== cp.closingCash) {
    logs.push(
      `إصلاح نقطة فحص السيولة لليوم (${dayKey}): رفع حد السيولة المعتمد من ${Math.round(oldOpening).toLocaleString("en-US")} ج.م إلى ${cleanCash.toLocaleString("en-US")} ج.م.`
    );
  }

  // 5. مطابقة عداد الدرج (dayTwentyNineDrawerTrackedCash) مع السيولة الحالية
  if ( typeof p.dayTwentyNineDrawerTrackedCash === "number" ) {
    p.dayTwentyNineDrawerTrackedCash = cleanCash;
    p.dayTwentyNineDrawerRemainder = 0;
  }

  // 6. رفع مؤشر تقدم القصة (storyIndex) بمقدار +2 لتخطي قفل المزامنة (storyDifference === 0) بعد اليوم 63
  if (dayNum >= 2) {
    const oldStoryIdx = Math.max(11, Math.floor(Number(p.storyIndex) || 11));
    p.storyIndex = Math.min(999, oldStoryIdx + 2);
    logs.push(
      `تنشيط مؤشر تقدم المزامنة السحابية (storyIndex: ${oldStoryIdx} ⬅ ${p.storyIndex}) لإجبار السيرفر على قبول السيولة الكاملة (${cleanCash.toLocaleString("en-US")} ج.م) فوراً.`
    );
  }

  return logs;
}

/**
 * فحص شامل لملف الحفظ وإرجاع تقرير مفصل بالمشاكل المكتشفة
 */
function inspectSaveFile(rawText) {
  let data;
  try {
    data = JSON.parse(rawText);
  } catch (err) {
    return { validJson: false, error: "الملف ليس بصيغة JSON صالحة أو أنه تالف." };
  }

  if (!data || data.format !== "bank-haroun-save" || !data.payload || typeof data.payload !== "object") {
    return { validJson: false, error: "هذا الملف ليس ملف حفظ صالح للعبة بنك هارون (bank-haroun-save)." };
  }

  const p = data.payload;
  const { checksum: expectedChecksum } = buildCanonicalEnvelope(data);
  const checksumMatch = String(data.checksum || "").toLowerCase() === expectedChecksum.toLowerCase();

  const ledger = Array.isArray(p.ledger) ? p.ledger : [];
  const netMachines = (p.atmNetworkV1 && Array.isArray(p.atmNetworkV1.machines)) ? p.atmNetworkV1.machines : [];
  const snapMachines = (p.storyAtmSnapshotV1 && p.storyAtmSnapshotV1.network && Array.isArray(p.storyAtmSnapshotV1.network.machines))
    ? p.storyAtmSnapshotV1.network.machines
    : [];
  const machines = netMachines.length >= snapMachines.length ? netMachines : snapMachines;
  const ownership = (p.storyAtmSnapshotV1 && p.storyAtmSnapshotV1.ownership && typeof p.storyAtmSnapshotV1.ownership === "object")
    ? p.storyAtmSnapshotV1.ownership
    : {};

  const purchaseEntries = ledger.filter(isAtmPurchaseEntry);
  const purchaseMap = new Map(purchaseEntries.map(e => [e.id, e]));

  const atmIssues = [];
  const brokenMachineIds = [];
  const healthyMachineIds = [];

  for (const m of machines) {
    const siteId = m && m.id;
    const receiptId = ownership[siteId];
    if (!VALID_ATM_SITES.has(siteId)) {
      atmIssues.push(`الماكينة (${siteId}) موقعها غير معروف.`);
      brokenMachineIds.push(siteId);
    } else if (!receiptId || !ATM_RECEIPT_REGEX.test(receiptId)) {
      atmIssues.push(`الماكينة (${siteId}) ليس لها رقم إيصال ملكية في storyAtmSnapshotV1.`);
      brokenMachineIds.push(siteId);
    } else if (!purchaseMap.has(receiptId)) {
      atmIssues.push(`الماكينة (${siteId}) إيصالها (${receiptId}) مفقود من سجل البنك (ledger) — غالباً بسبب امتلاء السجل عند 520 حركة.`);
      brokenMachineIds.push(siteId);
    } else {
      healthyMachineIds.push(siteId);
    }
  }

  // فحص الإيصالات اليتيمة (إيصال شراء في السجل بدون ماكينة في الشبكة)
  const ownedReceiptIds = new Set(Object.values(ownership));
  const orphanReceipts = purchaseEntries.filter(e => !ownedReceiptIds.has(e.id));
  if (orphanReceipts.length > 0 && machines.length === 0) {
    atmIssues.push(`يوجد ${orphanReceipts.length} إيصال شراء ATM في السجل بينما الشبكة فارغة (يسبب خطأ تعارض عند المزامنة).`);
  }

  // فحص مشكلة سيولة الاستثمار بعد اليوم 63 وفجوة dayCashCheckpoints
  const publicDay = getPublicDay(p);
  const dayKey = String(Math.max(1, Math.min(44, Math.floor(Number(p.day) || 1))));
  const cp = (p.dayCashCheckpoints && p.dayCashCheckpoints[dayKey]) || {};
  const checkpointOpeningCash = Number(cp.openingCash) || 0;
  const checkpointClosingCash = Number(cp.closingCash) || 0;
  const currentCash = Number(p.cash) || 0;

  let d63LastIdx = -1;
  for (let idx = 0; idx < ledger.length; idx++) {
    if (String(ledger[idx]?.id || "").startsWith("D63-")) {
      d63LastIdx = idx;
    }
  }
  let corpConvCash = 0;
  let atmLocalCashAfterStory = 0;
  if (d63LastIdx >= 0 && d63LastIdx < ledger.length - 1) {
    for (let idx = d63LastIdx + 1; idx < ledger.length; idx++) {
      const item = ledger[idx];
      const amt = Number(item?.amount) || 0;
      const idStr = String(item?.id || "");
      if (idStr.startsWith("CORP-CONV-")) corpConvCash += amt;
      if (idStr.startsWith("ATM-LOCAL-")) atmLocalCashAfterStory += amt;
    }
  }

  // حساب استثمارات هارون النشطة حالياً في السجل
  const invSubscribed = new Map();
  for (const item of ledger) {
    const idStr = String(item?.id || "");
    if (idStr.startsWith("ASSOC-INV-S-")) {
      const key = idStr.slice("ASSOC-INV-S-".length);
      invSubscribed.set(key, { amount: Math.abs(Number(item.amount) || 0), label: item.label });
    } else if (idStr.startsWith("ASSOC-INV-W-S-") || idStr.startsWith("ASSOC-INV-C-S-")) {
      const key = idStr.replace(/^ASSOC-INV-[WC]-S-/, "");
      invSubscribed.delete(key);
    }
  }

  const activeInvestments = Array.from(invSubscribed.values());
  const activeInvestedTotal = activeInvestments.reduce((acc, x) => acc + x.amount, 0);

  const hasCheckpointGap = checkpointOpeningCash < currentCash - 1 || checkpointClosingCash !== currentCash;
  const liquiditySyncWarning = (
    hasCheckpointGap ||
    (String(p.phase || "").endsWith("-complete") && (corpConvCash > 0 || atmLocalCashAfterStory > 0 || ledger.length >= 520))
  );

  return {
    validJson: true,
    data,
    checksumMatch,
    expectedChecksum,
    publicDay,
    internalDay: p.day,
    phase: p.phase,
    saveRevision: data.saveRevision || p.saveRevision || 0,
    cash: currentCash,
    checkpointOpeningCash,
    checkpointClosingCash,
    hasCheckpointGap,
    reputation: Number(p.reputation) || 0,
    ledgerCount: ledger.length,
    machinesCount: machines.length,
    healthyMachineIds,
    brokenMachineIds,
    atmIssues,
    orphanReceiptsCount: orphanReceipts.length,
    corpConvCash,
    atmLocalCashAfterStory,
    activeInvestments,
    activeInvestedTotal,
    liquiditySyncWarning,
    storyIndex: Number(p.storyIndex) || 11
  };
}

/**
 * تطبيق الإصلاح المطلوب على نسخة الحفظ وإرجاع النص الجاهز والتقرير
 * @param {string} rawText
 * @param {"full"|"liquidity"|"liquidity_refund"|"remove_bad_atm"|"remove_all_atm"|"checksum_only"} mode
 */
function repairSaveFile(rawText, mode = "full") {
  const report = inspectSaveFile(rawText);
  if (!report.validJson) {
    throw new Error(report.error);
  }

  const save = JSON.parse(rawText);
  const p = save.payload;
  const actionsTaken = [];

  if (!Array.isArray(p.ledger)) p.ledger = [];

  // 1. معالجة ماكينات الصراف الآلي وإيصالاتها حسب الوضع المختار
  if (mode === "full") {
    const net = (p.atmNetworkV1 && typeof p.atmNetworkV1 === "object")
      ? p.atmNetworkV1
      : (p.storyAtmSnapshotV1 && p.storyAtmSnapshotV1.network ? JSON.parse(JSON.stringify(p.storyAtmSnapshotV1.network)) : null);

    if (net && Array.isArray(net.machines) && net.machines.length > 0) {
      if (!p.storyAtmSnapshotV1 || typeof p.storyAtmSnapshotV1 !== "object") {
        p.storyAtmSnapshotV1 = { schema: 1, network: JSON.parse(JSON.stringify(net)), ownership: {} };
      }
      if (!p.storyAtmSnapshotV1.ownership || typeof p.storyAtmSnapshotV1.ownership !== "object") {
        p.storyAtmSnapshotV1.ownership = {};
      }

      const ownership = p.storyAtmSnapshotV1.ownership;
      let baseTs = Number(net.lastRealTime) || Date.now() - 3600000;
      let baseRev = Math.max(100, (Number(p.saveRevision) || 1000) - 50);

      for (let idx = 0; idx < net.machines.length; idx++) {
        const m = net.machines[idx];
        let recId = ownership[m.id];
        if (!recId || !ATM_RECEIPT_REGEX.test(recId)) {
          recId = `ATM-LOCAL-${baseTs + idx * 1000}-${baseRev + idx}-${idx + 1}`;
          ownership[m.id] = recId;
          actionsTaken.push(`إنشاء معرف إيصال ملكية رسمي للماكينة (${m.id}): ${recId}`);
        }

        const existingIdx = p.ledger.findIndex(e => e && e.id === recId);
        if (existingIdx === -1) {
          if (p.ledger.length >= 520) {
            const removableIdx = p.ledger.findIndex(e => {
              const id = String(e?.id || "");
              return !isAtmPurchaseEntry(e) && !id.startsWith("GIFT-") && !id.startsWith("ASSOC-") && !id.startsWith("ATM-SRV-");
            });
            if (removableIdx !== -1) {
              p.ledger.splice(removableIdx, 1);
            }
          }
          p.ledger.unshift({
            id: recId,
            amount: -2000000,
            label: "حركة شبكة ماكينات بنك هارون: تم إرسال طلب التركيب. الماكينة قيد الإنشاء لمدة خمس دقائق.",
            atmOperation: "purchase",
            atmSiteId: m.id
          });
          actionsTaken.push(`استعادة إيصال شراء الماكينة (${m.id}) في سجل البنك بدون خصم جديد من السيولة.`);
        } else {
          p.ledger[existingIdx].amount = -2000000;
        }
      }

      const activeIds = new Set(net.machines.map(m => m.id));
      for (const k of Object.keys(ownership)) {
        if (!activeIds.has(k)) delete ownership[k];
      }
      p.atmNetworkV1 = JSON.parse(JSON.stringify(net));
      p.storyAtmSnapshotV1.network = JSON.parse(JSON.stringify(net));
      p.atmCount = net.machines.length;
    }
  } else if (mode === "remove_bad_atm") {
    const net = p.atmNetworkV1 || (p.storyAtmSnapshotV1 && p.storyAtmSnapshotV1.network);
    const ownership = (p.storyAtmSnapshotV1 && p.storyAtmSnapshotV1.ownership) || {};
    const purchaseIds = new Set(p.ledger.filter(isAtmPurchaseEntry).map(e => e.id));

    if (net && Array.isArray(net.machines)) {
      const beforeCount = net.machines.length;
      const keptMachines = net.machines.filter(m => {
        const rId = ownership[m.id];
        return VALID_ATM_SITES.has(m.id) && rId && ATM_RECEIPT_REGEX.test(rId) && purchaseIds.has(rId);
      });
      const keptIds = new Set(keptMachines.map(m => m.id));
      const newOwnership = {};
      for (const [k, v] of Object.entries(ownership)) {
        if (keptIds.has(k)) newOwnership[k] = v;
      }
      const validOwnedReceipts = new Set(Object.values(newOwnership));
      p.ledger = p.ledger.filter(e => !isAtmPurchaseEntry(e) || validOwnedReceipts.has(e.id));

      net.machines = keptMachines;
      p.atmNetworkV1 = JSON.parse(JSON.stringify(net));
      if (p.storyAtmSnapshotV1) {
        p.storyAtmSnapshotV1.network = JSON.parse(JSON.stringify(net));
        p.storyAtmSnapshotV1.ownership = newOwnership;
      }
      p.atmCount = keptMachines.length;
      actionsTaken.push(`حذف ${beforeCount - keptMachines.length} ماكينة غير متوافقة وتنظيف إيصالاتها العالقة (${keptMachines.length} ماكينة سليمة متبقية).`);
    }
  } else if (mode === "remove_all_atm") {
    const emptyNet = {
      schema: 1,
      lastSlot: (p.atmNetworkV1 && p.atmNetworkV1.lastSlot) || 0,
      lastRealTime: (p.atmNetworkV1 && p.atmNetworkV1.lastRealTime) || Date.now(),
      machines: [],
      days: (p.atmNetworkV1 && Array.isArray(p.atmNetworkV1.days)) ? p.atmNetworkV1.days.slice(-31) : [],
      journal: []
    };
    p.atmNetworkV1 = JSON.parse(JSON.stringify(emptyNet));
    p.storyAtmSnapshotV1 = {
      schema: 1,
      network: JSON.parse(JSON.stringify(emptyNet)),
      ownership: {}
    };
    p.atmCount = 0;
    p.atmCash = 0;
    const beforeLedger = p.ledger.length;
    p.ledger = p.ledger.filter(e => !isAtmPurchaseEntry(e));
    actionsTaken.push(`مسح جميع ماكينات الصراف الآلي بالكامل وإزالة ${beforeLedger - p.ledger.length} إيصال شراء قديم لتجهيز الحساب للتعويض.`);
  }

  // 2. إصلاح مشكلة «السيولة غير الكافية» في الاستثمار والمزامنة (يعمل في جميع الأوضاع ما عدا checksum_only)
  if (mode !== "checksum_only") {
    const liqLogs = applyDeepLiquidityFix(p, {
      refundActiveInvestments: mode === "liquidity_refund"
    });
    actionsTaken.push(...liqLogs);

    const nextRev = Math.max(0, Math.floor(Number(save.saveRevision) || Number(p.saveRevision) || 0)) + 15;
    const nextTime = Math.max(Date.now(), Math.floor(Number(save.updatedAt) || Number(p.lastSavedAt) || 0) + 5000);
    save.saveRevision = nextRev;
    p.saveRevision = nextRev;
    save.updatedAt = nextTime;
    p.lastSavedAt = nextTime;
    actionsTaken.push(`رفع رقم الحفظ (saveRevision) إلى ${nextRev} لضمان اعتماد النسخة فوراً على السيرفر.`);
  }

  // 3. حساب البصمة الرسمية SHA-256 (JSON.stringify المباشر)
  const { envelope, checksum } = buildCanonicalEnvelope(save);
  const finalSave = {
    ...envelope,
    checksumAlgorithm: "SHA-256",
    checksum
  };
  actionsTaken.push(`ختم الملف ببصمة SHA-256 الرسمية المطابقة للعبة: ${checksum.slice(0, 16)}...`);

  return {
    repairedJson: JSON.stringify(finalSave, null, 2),
    finalSave,
    actionsTaken,
    checksum
  };
}

// ============================================================================
// 2. دوال التواصل مع Telegram Bot API (بدون أي مكتبات خارجية)
// ============================================================================

function callTelegramApi(method, payload) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${BOT_TOKEN}/${method}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": body.length
        }
      },
      res => {
        let chunks = [];
        res.on("data", d => chunks.push(d));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            resolve(parsed);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function sendTelegramDocument(chatId, fileName, fileBuffer, caption, replyMarkup = null) {
  return new Promise((resolve, reject) => {
    const boundary = "----BankHarounBotBoundary" + crypto.randomBytes(12).toString("hex");
    const parts = [];

    const addField = (name, val) => {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${val}\r\n`,
          "utf8"
        )
      );
    };

    addField("chat_id", String(chatId));
    if (caption) addField("caption", caption);
    addField("parse_mode", "HTML");
    if (replyMarkup) addField("reply_markup", JSON.stringify(replyMarkup));

    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${fileName}"\r\nContent-Type: application/json\r\n\r\n`,
        "utf8"
      )
    );
    parts.push(fileBuffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"));

    const body = Buffer.concat(parts);

    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${BOT_TOKEN}/sendDocument`,
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length
        }
      },
      res => {
        let chunks = [];
        res.on("data", d => chunks.push(d));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function downloadTelegramFile(fileId) {
  return new Promise(async (resolve, reject) => {
    try {
      const info = await callTelegramApi("getFile", { file_id: fileId });
      if (!info.ok || !info.result || !info.result.file_path) {
        return reject(new Error("تعذر جلب مسار الملف من تيليجرام."));
      }
      const filePath = info.result.file_path;
      https
        .get(`https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`, res => {
          const chunks = [];
          res.on("data", d => chunks.push(d));
          res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        })
        .on("error", reject);
    } catch (err) {
      reject(err);
    }
  });
}

// ============================================================================
// 3. معالجة رسائل وأزرار المستخدم في تيليجرام
// ============================================================================

function buildRepairKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "🔧 إصلاح شامل (إيصالات + سيولة الاستثمار + البصمة)", callback_data: "fix:full" }
      ],
      [
        { text: "💰 إصلاح مشكلة «السيولة غير الكافية» في الاستثمار فقط", callback_data: "fix:liquidity" }
      ],
      [
        { text: "🔄 إصلاح السيولة + استرداد الاستثمارات النشطة للبنك", callback_data: "fix:liquidity_refund" }
      ],
      [
        { text: "🏧 حذف الماكينات غير المتوافقة (تجهيز للتعويض)", callback_data: "fix:remove_bad_atm" }
      ],
      [
        { text: "🗑️ مسح كل ماكينات ATM (تصفير الشبكة للتعويض)", callback_data: "fix:remove_all_atm" }
      ],
      [
        { text: "🔐 إعادة ختم البصمة الرسمية فقط (SHA-256)", callback_data: "fix:checksum_only" }
      ]
    ]
  };
}

function formatDiagnosticReport(info, fileName) {
  const lines = [
    `🏦 <b>تقرير فحص ملف حفظ بنك هارون (v3.2)</b>`,
    `📄 <b>الملف:</b> <code>${fileName}</code>`,
    ``,
    `🔹 <b>اليوم الفعلي:</b> اليوم ${info.publicDay} (المرحلة: <code>${info.phase}</code>)`,
    `🔹 <b>السيولة الظاهرة في البنك:</b> <b>${Math.round(info.cash).toLocaleString("en-US")} ج.م</b>`,
    `🔹 <b>حد السيولة في نقطة الفحص (openingCash):</b> <b>${Math.round(info.checkpointOpeningCash).toLocaleString("en-US")} ج.م</b> ${info.hasCheckpointGap ? "⚠️ (منخفض ويمنع الاستثمار الكامل!)" : "✅"}`,
    `🔹 <b>رقم المراجعة (Revision):</b> <code>${info.saveRevision}</code>`,
    `🔹 <b>حجم السجل (Ledger):</b> ${info.ledgerCount} / 520 حركة`,
    `🔹 <b>بصمة الأمان (SHA-256):</b> ${info.checksumMatch ? "✅ سليمة ومطابقة" : "❌ غير مطابقة (تحتاج إعادة ختم)"}`,
    `🔹 <b>ماكينات الـ ATM:</b> ${info.machinesCount} ماكينة (${info.healthyMachineIds.length} سليمة، ${info.brokenMachineIds.length} بها مشكلة)`
  ];

  if (info.activeInvestments.length > 0) {
    lines.push(`🔹 <b>استثمارات نشطة حالياً:</b> ${info.activeInvestedTotal.toLocaleString("en-US")} ج.م (${info.activeInvestments.length} فرصة)`);
  }

  if (info.atmIssues.length > 0) {
    lines.push(``, `⚠️ <b>مشاكل ماكينات الصراف الآلي المكتشفة:</b>`);
    for (const iss of info.atmIssues) {
      lines.push(`• ${iss}`);
    }
  } else {
    lines.push(``, `✅ <b>شبكة الـ ATM:</b> كل الماكينات وإيصالاتها متطابقة.`);
  }

  if (info.liquiditySyncWarning) {
    lines.push(
      ``,
      `💡 <b>تشخيص مشكلة «السيولة غير الكافية» في الاستثمار:</b>`,
      `• حد السيولة المسجل في نقطة بداية اليوم (<code>openingCash</code>) متوقف عند <b>${Math.round(info.checkpointOpeningCash).toLocaleString("en-US")} ج.م</b> بينما سيولة البنك الفعلية <b>${Math.round(info.cash).toLocaleString("en-US")} ج.م</b>.`,
      `• كما أن ثبات مؤشر اليوم بعد اليوم 63 يمنع السيرفر من تحديث رصيدك في شاشة «استثمارات هارونية».`,
      `• اضغط على زر <b>«💰 إصلاح مشكلة السيولة غير الكافية في الاستثمار»</b> أو <b>«🔧 إصلاح شامل»</b> بالأسفل لمطابقة نقاط الفحص وتنشيط المزامنة السحابية فوراً!`
    );
  }

  lines.push(``, `👇 <b>اختر نوع الإصلاح المطلوب من الأزرار التالية:</b>`);
  return lines.join("\n");
}

async function handleUpdate(update) {
  try {
    if (update.callback_query) {
      const cb = update.callback_query;
      const chatId = cb.message?.chat?.id;
      const data = String(cb.data || "");

      if (!chatId || !data.startsWith("fix:")) return;
      const mode = data.slice(4);

      const session = userSessions.get(chatId);
      if (!session) {
        await callTelegramApi("answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "⚠️ انتهت الجلسة أو لم يتم العثور على الملف. أرسل ملف الحفظ مرة أخرى.",
          show_alert: true
        });
        return;
      }

      await callTelegramApi("answerCallbackQuery", {
        callback_query_id: cb.id,
        text: "⏳ جاري إصلاح السيولة والملف وختم البصمة الرسمية..."
      });

      const result = repairSaveFile(session.rawText, mode);
      const baseName = session.fileName.replace(/\.json$/i, "").replace(/\.haroun$/i, "");
      const outName = `${baseName}-Fixed-${mode}.haroun.json`;

      const captionLines = [
        `✅ <b>تم إصلاح الملف بنجاح!</b>`,
        `💰 <b>السيولة المعتمدة للبنك والاستثمار:</b> ${Math.round(result.finalSave.payload.cash).toLocaleString("en-US")} ج.م`,
        `🔢 <b>رقم الحفظ الجديد:</b> <code>${result.finalSave.saveRevision}</code>`,
        `🔐 <b>البصمة:</b> <code>${result.checksum.slice(0, 20)}...</code>`,
        ``,
        `🛠 <b>الإصلاحات التي تمت:</b>`,
        ...result.actionsTaken.map(a => `• ${a}`),
        ``,
        `📌 <b>الخطوة التالية داخل اللعبة:</b>`,
        `1️⃣ حمّل هذا الملف وادخل اللعبة ⬅ <b>نسخة تقدم على الجهاز</b> ⬅ <b>استرجاع التقدم من ملف</b>.`,
        `2️⃣ بعد إعادة تشغيل اللعبة، افتح <b>حساب اللاعب</b> واضغط <b>«مزامنة التقدم»</b> لكي يقرأ سيرفر الاستثمارات سيولتك الكاملة فوراً.`
      ];

      await sendTelegramDocument(
        chatId,
        outName,
        Buffer.from(result.repairedJson, "utf8"),
        captionLines.join("\n"),
        buildRepairKeyboard()
      );
      return;
    }

    const msg = update.message;
    if (!msg || !msg.chat) return;
    const chatId = msg.chat.id;

    if (msg.text && (msg.text.startsWith("/start") || msg.text.startsWith("/help"))) {
      const welcome = [
        `أهلاً بك في <b>بوت فحص وإصلاح ملفات حفظ بنك هارون (v3.2)</b> 🏦✨`,
        ``,
        `أرسل لي أي ملف حفظ (<code>.haroun</code> أو <code>.json</code>) وسأقوم فوراً بـ:`,
        `1️⃣ حل مشكلة <b>«السيولة غير الكافية» في الاستثمار</b> رغم وجود سيولة في البنك (إصلاح فجوة <code>openingCash</code> في <code>dayCashCheckpoints</code> وتنشيط مؤشر مزامنة اليوم 63).`,
        `2️⃣ فحص البصمة الرسمية (SHA-256) وإصلاح خطأ <i>«بصمة ملف التقدم غير مطابقة»</i>.`,
        `3️⃣ استعادة إيصالات ماكينات الـ ATM المفقودة أو حذف الماكينات التالفة للحصول على تعويض إلياس.`,
        ``,
        `📎 <b>أرسل ملف الحفظ الآن كملف (Document) للبدء!</b>`
      ].join("\n");
      await callTelegramApi("sendMessage", {
        chat_id: chatId,
        text: welcome,
        parse_mode: "HTML"
      });
      return;
    }

    if (msg.document) {
      const doc = msg.document;
      const fileName = doc.file_name || "Bank-Haroun-Save.haroun.json";

      if (doc.file_size > 15 * 1024 * 1024) {
        await callTelegramApi("sendMessage", {
          chat_id: chatId,
          text: "❌ حجم الملف كبير جداً (يتجاوز 15 ميجابايت)."
        });
        return;
      }

      await callTelegramApi("sendMessage", {
        chat_id: chatId,
        text: "⏳ جاري تنزيل وفحص ملف الحفظ..."
      });

      const rawText = await downloadTelegramFile(doc.file_id);
      const report = inspectSaveFile(rawText);

      if (!report.validJson) {
        await callTelegramApi("sendMessage", {
          chat_id: chatId,
          text: `❌ <b>فشل الفحص:</b> ${report.error}`,
          parse_mode: "HTML"
        });
        return;
      }

      userSessions.set(chatId, {
        fileName,
        rawText,
        uploadedAt: Date.now()
      });

      const reportHtml = formatDiagnosticReport(report, fileName);
      await callTelegramApi("sendMessage", {
        chat_id: chatId,
        text: reportHtml,
        parse_mode: "HTML",
        reply_markup: buildRepairKeyboard()
      });
      return;
    }

    await callTelegramApi("sendMessage", {
      chat_id: chatId,
      text: "📎 من فضلك أرسل ملف الحفظ (<code>.haroun</code> أو <code>.json</code>) كملف (Document) لأقوم بفحصه وإصلاحه لك.",
      parse_mode: "HTML"
    });
  } catch (err) {
    console.error("Error handling update:", err);
  }
}

// ============================================================================
// 4. تشغيل البوت (Long Polling للكمبيوتر المحلي + HTTP Server للسيرفرات المجانية)
// ============================================================================

let lastUpdateId = 0;
let pollingActive = false;

async function startPolling() {
  if (pollingActive) return;
  pollingActive = true;

  await callTelegramApi("deleteWebhook", { drop_pending_updates: false }).catch(() => {});
  console.log("✅ البوت يعمل الآن بنظام Long Polling وجاهز لاستقبال ملفات الحفظ على تيليجرام!");

  while (pollingActive) {
    try {
      const res = await callTelegramApi("getUpdates", {
        offset: lastUpdateId + 1,
        timeout: 25,
        allowed_updates: ["message", "callback_query"]
      });

      if (res && res.ok && Array.isArray(res.result)) {
        for (const update of res.result) {
          lastUpdateId = Math.max(lastUpdateId, update.update_id);
          await handleUpdate(update);
        }
      }
    } catch (err) {
      console.error("Polling error:", err.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === `/webhook/${BOT_TOKEN}`) {
    const chunks = [];
    req.on("data", d => chunks.push(d));
    req.on("end", async () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      try {
        const update = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        await handleUpdate(update);
      } catch (e) {
        console.error("Webhook parse error:", e);
      }
    });
    return;
  }

  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("🏦 Bank Haroun Save Doctor Telegram Bot v3.2 is running!\n");
});

server.listen(PORT, async () => {
  console.log(`🌐 HTTP Server listening on port ${PORT}`);
  if (!BOT_TOKEN || BOT_TOKEN === "PUT_YOUR_TELEGRAM_BOT_TOKEN_HERE") {
    console.log("⚠️ تنبيه: لم تقم بوضع BOT_TOKEN بعد! افتح الملف وضع التوكن الخاص بك من @BotFather.");
    return;
  }

  if (WEBHOOK_URL) {
    const fullWebhook = `${WEBHOOK_URL.replace(/\/+$/, "")}/webhook/${BOT_TOKEN}`;
    const wh = await callTelegramApi("setWebhook", { url: fullWebhook });
    console.log("🔗 Webhook mode enabled:", wh);
  } else {
    startPolling();
  }
});