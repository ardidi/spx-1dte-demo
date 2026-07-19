/**
 * SPX 1DTE 裸賣 Put 機器人
 * =========================
 * 每個交易日在盤中挑一檔「隔日到期、約 7 delta」的 SPX put 賣出，
 * 收權利金，同時預先掛好一張 GTC 停利單（權利金跌到剩 22% 就自動買回，
 * 等於鎖住 78% 獲利）。掛完就結束 —— 剩下的交給 IBKR。
 *
 * 邏輯很短，整支可以一次讀完：
 *   1. 連上 IBKR
 *   2. 檢查有沒有開盤、在不在進場時段、帳戶夠不夠
 *   3. 找到最接近 7 delta 的 put
 *   4. 賣出，並同時掛好自動停利
 *   5. 收工
 *
 * ⚠️ 預設連的是「模擬倉」(paper, port 4002)。確認滿意再改成實倉。
 *
 * 執行： node spx-1dte-naked-put.js
 */

const { IBKRBroker } = require('./ibkr-broker');

// ─────────────────────────────────────────────────────────────
// 參數：想調什麼直接改這裡就好
// ─────────────────────────────────────────────────────────────
const CONFIG = {
  // 連線（本機跑 Gateway 就用 127.0.0.1；連別台機器改 IP）
  host: process.env.IBKR_HOST || '127.0.0.1',
  port: Number(process.env.IBKR_PORT) || 4002,   // 4002=模擬倉  4001=實倉  7497=TWS模擬
  clientId: Number(process.env.IBKR_CLIENT_ID) || 55,
  // 行情資料型態：'auto'=自動先試即時，偵測到沒訂閱就跳提示改用延遲(~15分鐘)並繼續跑。
  // 也可強制指定：1=即時(需訂閱) 3=延遲。留白就用 auto，不用設定。
  marketDataType: process.env.IBKR_MKT_DATA_TYPE || 'auto',

  // 策略
  targetDelta: 0.07,     // 要賣的 put 大約幾 delta（0.07 = 7 delta）
  profitTarget: 0.78,    // 停利幅度：權利金跌到剩 (1 - 0.78) = 22% 時買回
  quantity: 1,           // 每次賣幾口
  minPremium: 1.0,       // 權利金低於這個金額($/股)就不做，避免賺太少還占保證金
  minDte: 1,             // 挑幾天後到期（1 = 隔日到期）

  // 安全閥：挑到的 delta 若比目標大太多倍就放棄（怕挑到太價內的危險履約價）
  deltaSafetyMultiple: 3,

  // 進場時段（美東時間）：太早報價不穩、太晚沒時間。09:50–15:00 之間才進場
  entryStartHour: 9, entryStartMinute: 50,
  entryEndHour: 15, entryEndMinute: 0,

  dryRun: false,         // true = 只印出「會下什麼單」但不真的送出
};

// ─────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────
function log(...args) {
  const t = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date());
  console.log(`[${t} ET]`, ...args);
}

// 現在（美東）在不在進場時段內
function withinEntryWindow(cfg) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(new Date());
  const get = (t) => p.find((x) => x.type === t)?.value;
  const hh = Number(get('hour')), mm = Number(get('minute'));
  const wd = get('weekday');
  if (wd === 'Sat' || wd === 'Sun') return false;
  const nowMin = hh * 60 + mm;
  const start = cfg.entryStartHour * 60 + cfg.entryStartMinute;
  const end = cfg.entryEndHour * 60 + cfg.entryEndMinute;
  return nowMin >= start && nowMin <= end;
}

// ─────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────
async function run(cfg = CONFIG) {
  const broker = new IBKRBroker({ host: cfg.host, port: cfg.port, clientId: cfg.clientId, marketDataType: cfg.marketDataType, log });

  log(`🔌 連線 IBKR ${cfg.host}:${cfg.port} (clientId ${cfg.clientId}) ...`);
  await broker.connect();
  log('✅ 已連線');

  try {
    // 1) 查帳 —— 順便確認連線真的能拿到資料
    const acct = await broker.getAccountSummary();
    log(`💰 帳戶淨值 $${acct.netLiquidation.toLocaleString()} ｜ 可用資金 $${acct.availableFunds.toLocaleString()}`);

    // 2) 今天開盤嗎？
    const open = await broker.isMarketOpenToday();
    if (!open) { log('🛑 今天休市，不進場。'); return; }

    // 3) 在進場時段嗎？
    if (!withinEntryWindow(cfg)) {
      log(`🕐 目前不在進場時段（${cfg.entryStartHour}:${String(cfg.entryStartMinute).padStart(2, '0')}–${cfg.entryEndHour}:00 ET），不進場。`);
      return;
    }

    // 4) SPX 現價 + 下一個到期日
    const spx = await broker.getSpxPrice();
    log(`📈 SPX 現價 ≈ ${spx.toFixed(2)}`);
    const expiry = await broker.getNextExpiry(cfg.minDte);
    log(`📅 目標到期日 ${expiry}`);

    // 5) 找 7 delta 的 put
    log(`🔎 搜尋約 ${(cfg.targetDelta * 100).toFixed(0)} delta 的 put ...`);
    const put = await broker.findPutByDelta(expiry, spx, cfg.targetDelta);
    if (!put) { log('⚠️ 這輪找不到合適的合約，收工。'); return; }
    log(`🎯 選中 ${expiry} ${put.strike}P ｜ delta ${put.delta.toFixed(3)} ｜ bid ${put.bid} / ask ${put.ask} ｜ mid ${put.mid.toFixed(2)}`);

    // 6) 安全檢查
    if (put.delta > cfg.targetDelta * cfg.deltaSafetyMultiple) {
      log(`🛑 安全閥：選到的 delta ${put.delta.toFixed(3)} 超過目標 ${cfg.deltaSafetyMultiple} 倍，放棄以免太價內。`);
      return;
    }
    if (put.mid < cfg.minPremium) {
      log(`🛑 權利金 $${put.mid.toFixed(2)} 低於下限 $${cfg.minPremium}，不划算，放棄。`);
      return;
    }

    // 7) 賣出 + 掛好自動停利，然後就不管了
    const entryPrice = put.mid;                          // 用中間價掛賣單
    const tpPrice = entryPrice * (1 - cfg.profitTarget); // 買回目標 = 22% 權利金
    const credit = entryPrice * 100 * cfg.quantity;
    log(`📤 賣出 ${cfg.quantity} 口 ${put.strike}P @ $${entryPrice.toFixed(2)}（收約 $${credit.toFixed(0)}）｜ 自動停利買回 @ $${tpPrice.toFixed(2)}`);

    const ids = broker.sellPutWithStandingTP(expiry, put.strike, cfg.quantity, entryPrice, tpPrice, cfg.dryRun);
    log(`🧾 已送出：建倉單 #${ids.parentId} + GTC 停利單 #${ids.childId}`);
    log('👍 完成。停利單已預掛，程式可以關掉了，剩下交給 IBKR。');
  } finally {
    // 留 2 秒讓最後的下單訊息送達 Gateway，再斷線
    await new Promise((r) => setTimeout(r, 2000));
    broker.disconnect();
    log('🔌 已斷線');
  }
}

if (require.main === module) {
  run().catch((err) => {
    log('❌ 出錯：', err.message);
    process.exit(1);
  });
}

module.exports = { run, CONFIG, withinEntryWindow };
