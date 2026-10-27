/**
 * ============================================================================
 * 🏦 بوت تيليجرام لفحص وإصلاح ملفات حفظ بنك هارون (Bank Haroun Save Doctor Bot)
 * الإصدار: v3.7 (مختبر على ملفات حقيقية ضد diagnoseRemoteFinancialHistory و reconcileStoryAtmSave وحارس مرآة الـATM)
 * ============================================================================
 *
 * المميزات:
 * 1. يعمل بدون أي مكتبات خارجية (Zero Dependencies) — يستخدم مكتبات Node.js المدمجة فقط.
 * 2. يدعم قائمة الصلاحيات (ALLOWED_USER_IDS Whitelist) لحماية البوت وحصره على الأدمن فقط.
 * 3. يحافظ 100% على:
 *    - السيولة الفعلية (p.cash) بدون أي تقريب أو تعديل (لتجنب STORY_ATM_UNEXPLAINED_CASH على السيرفر).
 *    - استمرارية السجل المالي (p.ledger) بدون أي حذف أو إزاحة (shift / unshift / filter / push / slice).
 *    - بيانات القصة ونقاط الفحص (storyIndex / daySixtyTwoDecisionResults / dayCashCheckpoints) بدون أي تعديل.
 * 4. يعالج:
 *    - تثبيت إثبات ملكية ماكينات الصراف الآلي في storyAtmSnapshotV1.ownership ليعمل مع 1.69.395+ و 1.69.400+.
 *    - تحييد إيصالات الشراء اليتيمة في مكانها داخل السجل (تعديل label وحذف atmOperation و atmSiteId فقط).
 *    - زيادة storyAtmControlRevisionV1 بمقدار +1 فقط عند حذف ماكينة فعلياً أو تحييد إيصال يتيم.
 *    - ختم الملف ببصمة SHA-256 الرسمية المباشرة JSON.stringify(a).
 * ============================================================================
 */

const https = require("https");
const http = require("http");
const crypto = require("crypto");

// ضع توكن البوت الخاص بك هنا من @BotFather أو مرره عبر متغير البيئة BOT_TOKEN
const BOT_TOKEN = process.env.BOT_TOKEN || "PUT_YOUR_TELEGRAM_BOT_TOKEN_HERE";
const PORT = Number(process.env.PORT || 3000);
const WEBHOOK_URL = process.env.WEBHOOK_URL || ""; // اختياري للسيرفرات السحابية

// قائمة معرفات تيليجرام المسموح لها باستخدام البوت (Whitelist لحماية أداة الأدمن)
// v3.7: لو المتغير فاضي البوت يرفض الجميع (بدل ما يسمح للجميع). أي شخص يبعت رسالة هيشوف الـ ID بتاعه في رد الرفض،
// وتحطه في متغير البيئة ALLOWED_USER_IDS مفصولة بفاصلة مثل: "123456789,987654321"
const ALLOWED_USER_IDS = new Set(
  (process.env.ALLOWED_USER_IDS || "")
    .split(",")
    .map(s => Number(s.trim()))
    .filter(n => Number.isSafeInteger(n) && n > 0)
);

function isUserAllowed(userId) {
  if (ALLOWED_USER_IDS.size === 0) return false;
  return ALLOWED_USER_IDS.has(Number(userId));
}

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
  const payload = JSON.parse(JSON.stringify(saveObj.payload || {}));
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
 * تطبيق الإصلاح العميق لمشكلة «السيولة غير الكافية» في الاستثمار والمزامنة السحابية (v3.6)
 */
/**
 * مطابقة عداد الماكينات وتجهيز الملف للمزامنة الآمنة مع السيرفر (v3.6)
 * ملاحظة هامة (بناءً على مراجعة كود السيرفر reconcileStoryAtmSave و investment-system.js):
 * - لا يتم المساس بـ p.cash أو تقريبها أبداً لتجنب خطأ STORY_ATM_UNEXPLAINED_CASH على السيرفر.
 * - لا يتم المساس بـ p.ledger أو dayCashCheckpoints أو storyIndex أو daySixtyTwoDecisionResults.
 */
function applyDeepLiquidityFix(p) {
  const logs = [];
  if (!p || typeof p !== "object") return logs;

  if (p.atmNetworkV1 && Array.isArray(p.atmNetworkV1.machines) && p.atmCount !== p.atmNetworkV1.machines.length) {
    p.atmCount = p.atmNetworkV1.machines.length;
    logs.push(`مطابقة عداد ماكينات الـ ATM (atmCount) إلى ${p.atmCount} ماكينة.`);
  }

  return logs;
}

function inspectSaveFile(rawText) {
  let data;
  try {
    data = JSON.parse(rawText);
  } catch (err) {
    return { validJson: false, error: "الملف ليس بصيغة JSON صالحة أو أنه تالف." };
  }

  if (data && typeof data === "object" && !data.payload && (typeof data.cash === "number" || typeof data.day === "number")) {
    data = {
      format: "bank-haroun-save",
      saveVersion: 1,
      gameVersion: "1.69.389",
      createdAt: new Date().toISOString(),
      completedDay: Math.max(0, Math.floor(Number(data.day) || 1) - 1),
      currentDay: Math.max(1, Math.floor(Number(data.day) || 1)),
      saveRevision: Math.max(1, Math.floor(Number(data.saveRevision) || 1)),
      updatedAt: Number(data.lastSavedAt) || Date.now(),
      payload: data
    };
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

  // فحص مشكلة سيولة الاستثمار بعد اليوم 63 وفجوة dayCashCheckpoints (openingCash & closingCash)
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

  const isOpeningLow = checkpointOpeningCash < currentCash - 1;
  const isClosingDesynced = Math.round(checkpointClosingCash) !== Math.round(currentCash);
  const hasFractionalStartCash = (typeof p.daySixtyTwoStartCash === "number" && !Number.isInteger(p.daySixtyTwoStartCash)) || !Number.isInteger(currentCash);
  const hasCheckpointGap = isOpeningLow || isClosingDesynced || hasFractionalStartCash;
  const liquiditySyncWarning = (
    hasCheckpointGap ||
    (String(p.phase || "").endsWith("-complete") && (corpConvCash > 0 || atmLocalCashAfterStory > 0 || ledger.length >= 200))
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
    isOpeningLow,
    isClosingDesynced,
    hasFractionalStartCash,
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
 * @param {"full"|"liquidity"|"remove_bad_atm"|"remove_all_atm"|"checksum_only"} mode
 */
function repairSaveFile(rawText, mode = "full") {
  const report = inspectSaveFile(rawText);
  if (!report.validJson) {
    throw new Error(report.error);
  }

  let save = JSON.parse(rawText);
  if (save && typeof save === "object" && !save.payload && (typeof save.cash === "number" || typeof save.day === "number")) {
    save = {
      format: "bank-haroun-save",
      saveVersion: 1,
      gameVersion: "1.69.389",
      createdAt: new Date().toISOString(),
      completedDay: Math.max(0, Math.floor(Number(save.day) || 1) - 1),
      currentDay: Math.max(1, Math.floor(Number(save.day) || 1)),
      saveRevision: Math.max(1, Math.floor(Number(save.saveRevision) || 1)),
      updatedAt: Number(save.lastSavedAt) || Date.now(),
      payload: save
    };
  }
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
        if (existingIdx !== -1) {
          p.ledger[existingIdx].atmOperation = "purchase";
          p.ledger[existingIdx].atmSiteId = m.id;
        } else {
          actionsTaken.push(`تثبيت إثبات ملكية الماكينة (${m.id}) في storyAtmSnapshotV1.ownership (${recId}) ليعمل مع معالج 1.69.395+ دون المساس بترتيب الـ 520 حركة في السجل.`);
        }
      }

      const activeIds = new Set(net.machines.map(m => m.id));
      for (const k of Object.keys(ownership)) {
        if (!activeIds.has(k)) delete ownership[k];
      }
      p.atmNetworkV1 = JSON.parse(JSON.stringify(net));
      p.storyAtmSnapshotV1.network = JSON.parse(JSON.stringify(net));
      p.atmCount = net.machines.length;
      delete p.atmRestartLockedDay;
    }
  } else if (mode === "remove_bad_atm") {
    const net = p.atmNetworkV1 || (p.storyAtmSnapshotV1 && p.storyAtmSnapshotV1.network);
    const ownership = (p.storyAtmSnapshotV1 && p.storyAtmSnapshotV1.ownership) || {};
    const purchaseIds = new Set(p.ledger.filter(isAtmPurchaseEntry).map(e => e.id));

    let removedMachinesCount = 0;
    let neutralizedCount = 0;

    if (net && Array.isArray(net.machines)) {
      const beforeCount = net.machines.length;
      const keptMachines = net.machines.filter(m => {
        const rId = ownership[m.id];
        return VALID_ATM_SITES.has(m.id) && rId && ATM_RECEIPT_REGEX.test(rId) && purchaseIds.has(rId);
      });
      removedMachinesCount = beforeCount - keptMachines.length;
      const keptIds = new Set(keptMachines.map(m => m.id));
      const newOwnership = {};
      for (const [k, v] of Object.entries(ownership)) {
        if (keptIds.has(k)) newOwnership[k] = v;
      }
      const validOwnedReceipts = new Set(Object.values(newOwnership));
      for (const e of p.ledger) {
        if (isAtmPurchaseEntry(e) && !validOwnedReceipts.has(e.id)) {
          delete e.atmOperation;
          delete e.atmSiteId;
          e.label = "حركة شبكة ماكينات بنك هارون: تسوية إغلاق موقع ماكينة صراف آلي.";
          neutralizedCount++;
        }
      }

      if (keptMachines.length === 0) {
        delete p.atmNetworkV1;
        delete p.storyAtmSnapshotV1;
        p.atmCount = 0;
      } else {
        net.machines = keptMachines;
        p.atmNetworkV1 = JSON.parse(JSON.stringify(net));
        if (p.storyAtmSnapshotV1) {
          p.storyAtmSnapshotV1.network = JSON.parse(JSON.stringify(net));
          p.storyAtmSnapshotV1.ownership = newOwnership;
        }
        p.atmCount = keptMachines.length;
      }
      delete p.atmRestartLockedDay;
    } else {
      for (const e of p.ledger) {
        if (isAtmPurchaseEntry(e)) {
          delete e.atmOperation;
          delete e.atmSiteId;
          e.label = "حركة شبكة ماكينات بنك هارون: تسوية إغلاق موقع ماكينة صراف آلي.";
          neutralizedCount++;
        }
      }
      delete p.atmNetworkV1;
      delete p.storyAtmSnapshotV1;
      delete p.atmRestartLockedDay;
      p.atmCount = 0;
    }

    if (removedMachinesCount > 0 || neutralizedCount > 0) {
      p.storyAtmControlRevisionV1 = Math.max(0, Math.floor(Number(p.storyAtmControlRevisionV1) || 0)) + 1;
    }
    actionsTaken.push(`حذف ${removedMachinesCount} ماكينة غير متوافقة وتحييد ${neutralizedCount} إيصال شراء يتيم في مكانه دون المساس بطول أو ترتيب السجل.`);
  } else if (mode === "neutralize_orphans") {
    // v3.7: تحييد إيصالات الشراء اليتيمة فقط (إيصال شراء -2,000,000 بدون ماكينة تملكه) من غير لمس الماكينات وبدون رفع
    // storyAtmControlRevisionV1. السيرفر هو اللي يقرر: لو عنده الماكينات يطلب الاستعادة (الصح)، ولو مفيهوش يقبل الملف.
    // ملاحظة: التحييد بيشيل دليل الدفع من الملف، فاستخدمه بعد ما تقرر إن اللاعب هياخد تعويض من الدعم.
    const net = p.atmNetworkV1 || (p.storyAtmSnapshotV1 && p.storyAtmSnapshotV1.network);
    const ownership = (p.storyAtmSnapshotV1 && p.storyAtmSnapshotV1.ownership) || {};
    const machineIds = new Set(net && Array.isArray(net.machines) ? net.machines.map(m => m.id) : []);
    const ownedReceipts = new Set(Object.entries(ownership).filter(([site]) => machineIds.has(site)).map(([, id]) => id));
    let neutralized = 0;
    for (const e of p.ledger) {
      if (isAtmPurchaseEntry(e) && !ownedReceipts.has(e.id)) {
        delete e.atmOperation;
        delete e.atmSiteId;
        e.label = "حركة شبكة ماكينات بنك هارون: تسوية إغلاق موقع ماكينة صراف آلي.";
        neutralized++;
      }
    }
    delete p.atmRestartLockedDay;
    actionsTaken.push(`تحييد ${neutralized} إيصال شراء يتيم في مكانه (id والمبلغ وترتيب السجل زي ما هم) من غير رفع رقم مراجعة الـATM ومن غير لمس الماكينات.`);
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
    let neutralized = 0;
    for (const e of p.ledger) {
      if (isAtmPurchaseEntry(e)) {
        delete e.atmOperation;
        delete e.atmSiteId;
        e.label = "حركة شبكة ماكينات بنك هارون: تسوية إغلاق موقع ماكينة صراف آلي.";
        neutralized++;
      }
    }
    delete p.atmNetworkV1;
    delete p.storyAtmSnapshotV1;
    delete p.atmRestartLockedDay;
    p.storyAtmControlRevisionV1 = Math.max(0, Math.floor(Number(p.storyAtmControlRevisionV1) || 0)) + 1;
    actionsTaken.push(`مسح جميع ماكينات الصراف الآلي بالكامل وتحييد ${neutralized} إيصال شراء قديم لتجهيز الحساب للتعويض بأمان مع المزامنة.`);
  }

  // 2. إصلاح مشكلة «السيولة غير الكافية» في الاستثمار والمزامنة (يعمل في جميع الأوضاع ما عدا checksum_only)
  if (mode !== "checksum_only") {
    const liqLogs = applyDeepLiquidityFix(p);
    actionsTaken.push(...liqLogs);

    const nextRev = Math.max(0, Math.floor(Number(save.saveRevision) || Number(p.saveRevision) || 0)) + 500;
    const nextTime = Math.max(Date.now(), Math.floor(Number(save.updatedAt) || Number(p.lastSavedAt) || 0) + 10000);
    save.saveRevision = nextRev;
    p.saveRevision = nextRev;
    save.updatedAt = nextTime;
    p.lastSavedAt = nextTime;
    actionsTaken.push(`رفع رقم المراجعة (saveRevision) بمقدار +500 إلى ${nextRev} لضمان تفوق نسخة جهازك على السيرفر.`);
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

function sendTelegramDocument(chatId, fileName, fileBuffer, caption, replyMarkup = null, replyToMessageId = null) {
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

    // حد تيليجرام الأقصى لوصف الملف (caption) هو 1024 حرفاً فقط!
    // إذا زاد النص عن 1000 حرف يتجاهل تيليجرام إرسال الملف تماماً (media_caption_too_long)
    let safeCaption = String(caption || "");
    if (safeCaption.length > 980) {
      safeCaption = safeCaption.slice(0, 960) + "\n...";
      // إزالة أي وسم HTML مفتوح في نهاية القص
      const lastOpen = safeCaption.lastIndexOf("<");
      const lastClose = safeCaption.lastIndexOf(">");
      if (lastOpen > lastClose) {
        safeCaption = safeCaption.slice(0, lastOpen);
      }
    }

    const safeFileName = String(fileName || "Bank-Haroun-Save-Fixed.haroun.json")
      .replace(/["\\\r\n]/g, "_");

    addField("chat_id", String(chatId));
    if (safeCaption) addField("caption", safeCaption);
    addField("parse_mode", "HTML");
    if (replyToMessageId) addField("reply_to_message_id", String(replyToMessageId));
    if (replyMarkup) addField("reply_markup", JSON.stringify(replyMarkup));

    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${safeFileName}"\r\nContent-Type: application/json\r\n\r\n`,
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
        { text: "🔄 تحديث رقم المراجعة للمزامنة (saveRevision +500)", callback_data: "fix:liquidity" }
      ],
      [
        { text: "🧾 تحييد إيصالات الشراء اليتيمة فقط (من غير رفع رقم المراجعة)", callback_data: "fix:neutralize_orphans" }
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
    `🏦 <b>تقرير فحص ملف حفظ بنك هارون (v3.6)</b>`,
    `📄 <b>الملف:</b> <code>${fileName}</code>`,
    ``,
    `🔹 <b>اليوم الفعلي:</b> اليوم ${info.publicDay} (المرحلة: <code>${info.phase}</code>)`,
    `🔹 <b>السيولة الظاهرة في البنك:</b> <b>${Math.round(info.cash).toLocaleString("en-US")} ج.م</b>`,
    `🔹 <b>نقطة افتتاح اليوم (openingCash):</b> <b>${Math.round(info.checkpointOpeningCash).toLocaleString("en-US")} ج.م</b> ${info.isOpeningLow ? "⚠️ (أقل من السيولة الحالية!)" : "✅"}`,
    `🔹 <b>نقطة إقفال اليوم (closingCash):</b> <b>${Math.round(info.checkpointClosingCash).toLocaleString("en-US")} ج.م</b> ${info.isClosingDesynced ? "⚠️ (متوقفة عند رصيد قديم ولا تطابق سيولة البنك!)" : "✅"}`,
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
    lines.push(``, `💡 <b>تشخيص مشكلة «السيولة غير الكافية» في الاستثمار (v3.6):</b>`);
    if (info.isClosingDesynced) {
      lines.push(
        `• رصيد إقفال اليوم المسجل في نقطة الفحص (<code>closingCash</code>) متوقف عند <b>${Math.round(info.checkpointClosingCash).toLocaleString("en-US")} ج.م</b> بينما سيولة البنك الفعلية <b>${Math.round(info.cash).toLocaleString("en-US")} ج.م</b> (بسبب بيع عملات للبنك المركزي أو جمع أرباح ATM بعد آخر مزامنة استثمار).`
      );
    }
    if (info.isOpeningLow) {
      lines.push(
        `• حد افتتاح اليوم (<code>openingCash</code>) متوقف عند <b>${Math.round(info.checkpointOpeningCash).toLocaleString("en-US")} ج.م</b> وهو أقل من سيولة البنك الفعلية.`
      );
    }
    lines.push(
      `• نقط الفحص دي معلومة فقط: السيرفر بيقارن <code>cash</code> بالمبلغ ولا يقرأ هذه النقط، والبوت لا يعدلها.`,
      `• <b>السبب المرجّح:</b> شاشة «استثمارات هارونية» تخصم من <b>نسخة السيرفر</b> وليس من متصفح اللاعب. اللعبة 1.69.400+ ترفع نسخة الجهاز تلقائياً قبل الاشتراك؛ لو لسه ظهرت الرسالة يفتح «حساب بنك هارون ⬅ مزامنة الآن» ثم يجرب تاني.`
    );
  }

  lines.push(``, `👇 <b>اختر نوع الإصلاح المطلوب من الأزرار التالية:</b>`);
  return lines.join("\n");
}

async function handleUpdate(update) {
  try {
    if (update.callback_query) {
      const cb = update.callback_query;
      if (!isUserAllowed(cb.from?.id)) {
        await callTelegramApi("answerCallbackQuery", {
          callback_query_id: cb.id,
          text: `⛔ هذا البوت مخصص للأدمن فقط. معرفك: ${cb.from?.id}`,
          show_alert: true
        });
        return;
      }
      const chatId = cb.message?.chat?.id;
      const data = String(cb.data || "");

      if (!chatId || !data.startsWith("fix:")) return;
      const mode = data.slice(4);

      let session = userSessions.get(chatId);
      // إذا أُعيد تشغيل السيرفر المجاني، نستعيد الملف تلقائياً من الرسالة الأصلية المربوطة بالتقرير!
      if (!session && cb.message?.reply_to_message?.document) {
        try {
          const origDoc = cb.message.reply_to_message.document;
          const rawText = await downloadTelegramFile(origDoc.file_id);
          session = {
            fileName: origDoc.file_name || "Bank-Haroun-Save.haroun.json",
            rawText,
            uploadedAt: Date.now(),
            origMsgId: cb.message.reply_to_message.message_id
          };
          userSessions.set(chatId, session);
        } catch (e) {
          console.error("Failed to auto-recover document from reply_to_message:", e);
        }
      }

      if (!session) {
        await callTelegramApi("answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "⚠️ انتهت الجلسة بسبب إعادة تشغيل السيرفر. أرسل ملف الحفظ مرة أخرى.",
          show_alert: true
        });
        return;
      }

      await callTelegramApi("answerCallbackQuery", {
        callback_query_id: cb.id,
        text: "⏳ جاري إصلاح الملف وإرساله..."
      });

      const result = repairSaveFile(session.rawText, mode);
      const baseName = session.fileName.replace(/\.json$/i, "").replace(/\.haroun$/i, "");
      const outName = `${baseName}-Fixed-${mode}.haroun`;

      // ملاحظة هامة: حد تيليجرام الأقصى لـ caption في sendDocument هو 1024 حرفاً فقط!
      // لذلك نجعل وصف الملف مختصراً وأقل من 800 حرف دائماً حتى لا يرفضه تيليجرام
      const shortCaptionLines = [
        `✅ <b>تم إصلاح الملف بنجاح (v3.6)!</b>`,
        `💰 <b>السيولة المعتمدة:</b> ${Math.round(result.finalSave.payload.cash).toLocaleString("en-US")} ج.م`,
        `🔢 <b>رقم المراجعة الجديد:</b> <code>${result.finalSave.saveRevision}</code>`,
        `🔐 <b>البصمة:</b> <code>${result.checksum.slice(0, 16)}...</code>`,
        ``,
        `🚨 <b>خطوة إجبارية بعد استعادة الملف داخل اللعبة:</b>`,
        `1️⃣ افتح <b>«حساب بنك هارون»</b> من القائمة الرئيسية.`,
        `2️⃣ اضغط <b>«اعتماد النسخة الأقوى»</b> (أو <b>«مزامنة الآن»</b>).`,
        `3️⃣ اضغط <b>«اعتمد نسخة جهازي»</b> لتحديث رصيدك على السيرفر، ثم ادخل <b>«استثمارات هارونية»</b>!`
      ];

      const sendRes = await sendTelegramDocument(
        chatId,
        outName,
        Buffer.from(result.repairedJson, "utf8"),
        shortCaptionLines.join("\n"),
        buildRepairKeyboard(),
        session.origMsgId || null
      );

      if (!sendRes || !sendRes.ok) {
        console.error("sendDocument failed:", sendRes);
        // محاولة إرسال بدون تنسيق HTML أو أزرار في حال وجود أي حرف خاص في اسم الملف
        const retryRes = await sendTelegramDocument(
          chatId,
          "Bank-Haroun-Save-Fixed.haroun.json",
          Buffer.from(result.repairedJson, "utf8"),
          "✅ تم إصلاح الملف بنجاح! استعد الملف ثم افتح «حساب بنك هارون ⬅ اعتماد النسخة الأقوى ⬅ اعتمد نسخة جهازي».",
          null,
          null
        );
        if (!retryRes || !retryRes.ok) {
          await callTelegramApi("sendMessage", {
            chat_id: chatId,
            text: `❌ تعذر إرسال الملف عبر تيليجرام: ${(sendRes && sendRes.description) || "خطأ غير معروف"}`
          });
          return;
        }
      }

      // إرسال تفاصيل الإصلاحات في رسالة نصية منفصلة إذا كانت كثيرة
      if (result.actionsTaken.length > 0) {
        const detailsText = [
          `🛠 <b>تفاصيل الإصلاحات التي تمت على الملف:</b>`,
          ...result.actionsTaken.map(a => `• ${a}`)
        ].join("\n");
        await callTelegramApi("sendMessage", {
          chat_id: chatId,
          text: detailsText,
          parse_mode: "HTML"
        });
      }
      return;
    }

    const msg = update.message;
    if (!msg || !msg.chat) return;
    const chatId = msg.chat.id;
    if (!isUserAllowed(msg.from?.id)) {
      await callTelegramApi("sendMessage", {
        chat_id: chatId,
        text: `⛔ <b>عذراً، هذا البوت خاص بأدمن لعبة بنك هارون فقط.</b>\nمعرف حسابك على تيليجرام (User ID): <code>${msg.from?.id}</code>`,
        parse_mode: "HTML"
      });
      return;
    }

    if (msg.text && (msg.text.startsWith("/start") || msg.text.startsWith("/help"))) {
      const welcome = [
        `أهلاً بك في <b>بوت فحص وإصلاح ملفات حفظ بنك هارون (v3.6)</b> 🏦✨`,
        ``,
        `أرسل لي أي ملف حفظ (<code>.haroun</code> أو <code>.json</code>) وسأقوم فوراً بـ:`,
        `1️⃣ تجهيز الملف للمزامنة (رفع رقم المراجعة saveRevision فقط). <b>السيولة والسجل لا يتغيروا أبداً.</b> مشكلة «السيولة غير الكافية» سببها نسخة السيرفر، واللعبة 1.69.400+ بترفع نسخة الجهاز قبل الاشتراك تلقائياً.`,
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
        uploadedAt: Date.now(),
        origMsgId: msg.message_id
      });

      const reportHtml = formatDiagnosticReport(report, fileName);
      await callTelegramApi("sendMessage", {
        chat_id: chatId,
        text: reportHtml,
        parse_mode: "HTML",
        reply_to_message_id: msg.message_id,
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
  console.log("✅ البوت (v3.6) يعمل الآن بنظام Long Polling وجاهز لاستقبال ملفات الحفظ على تيليجرام!");

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
  res.end("🏦 Bank Haroun Save Doctor Telegram Bot v3.6 is running!\n");
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