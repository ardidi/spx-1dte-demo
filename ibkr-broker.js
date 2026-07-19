/**
 * IBKR Broker — 精簡券商介面
 * =============================
 * 用 @stoqey/ib 連接 Interactive Brokers Gateway / TWS，
 * 只實作這支裸賣 put 機器人真正會用到的幾個動作：
 *
 *   連線 / 斷線 / 查帳 / 查 SPX 現價 / 找下一個到期日 /
 *   依 delta 挑履約價 / 賣出 put 並掛好自動停利。
 *
 * 沒有多餘的東西 —— 你可以整支讀完，確認它只是照你指定的參數下單。
 */

const { IBApi, EventName } = require('@stoqey/ib');

class IBKRBroker {
  /**
   * @param {object} opts
   * @param {string} opts.host   Gateway/TWS 主機（本機通常是 127.0.0.1）
   * @param {number} opts.port   4002 = IB Gateway 模擬倉；4001 = 實倉；7497 = TWS 模擬
   * @param {number} opts.clientId  API 連線編號（同一個 Gateway 每條連線要不同）
   * @param {number|string} [opts.marketDataType]  'auto'=先試即時、沒訂閱自動退延遲(預設)；也可指定 1=即時 2=凍結 3=延遲 4=延遲凍結
   * @param {function} [opts.log]   log 函式，預設 console.log
   */
  constructor({ host = '127.0.0.1', port = 4002, clientId = 55, marketDataType = 'auto', log = console.log } = {}) {
    this.host = host;
    this.port = port;
    this.clientId = clientId;
    this.marketDataType = marketDataType;
    this.log = log;

    this.ib = new IBApi({ host, port });
    this._connected = false;
    this._nextId = null;
    this._accountSummary = {};

    this._wireEvents();
  }

  get connected() { return this._connected; }

  _wireEvents() {
    this.ib.on(EventName.connected, () => { this._connected = true; });
    this.ib.on(EventName.disconnected, () => { this._connected = false; });

    // 拿到起始的訂單序號後才可以下單
    this.ib.on(EventName.nextValidId, (id) => { this._nextId = id; });

    // 帳戶摘要一格一格回傳，存起來
    this.ib.on(EventName.accountSummary, (reqId, account, tag, value, currency) => {
      this._accountSummary[tag] = { value, currency };
    });

    // 只把「真正的錯誤」印出來；2100~2160 與資料農場連線通知是正常訊息
    this.ib.on(EventName.error, (err, code, reqId) => {
      const msg = (err && err.message) || String(err);
      if (msg.includes('Cannot send data when disconnected')) return;
      if (code >= 2100 && code <= 2160) { this.log(`ℹ️  IBKR 通知 [${code}]: ${msg}`); return; }
      this.log(`⚠️  IBKR [${code}]: ${msg}`);
    });
  }

  // ---- 連線 -------------------------------------------------------------
  connect(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      this.ib.connect(this.clientId);
      this.ib.reqIds();
      const tick = setInterval(() => {
        if (this._connected && this._nextId !== null) {
          clearInterval(tick);
          resolve(true);
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(tick);
          reject(new Error(`連線逾時（${this.host}:${this.port}）—— Gateway 開了嗎？API 有勾選允許連線嗎？`));
        }
      }, 100);
    });
  }

  disconnect() {
    try { this.ib.disconnect(); } catch (e) { /* 已斷線 */ }
    this._connected = false;
  }

  _reqId() {
    // 用訂單序號兼作 market-data 的 request id；每次遞增避免撞號
    return this._nextId != null ? this._nextId++ : Math.floor(Math.random() * 100000);
  }

  // ---- 查帳 -------------------------------------------------------------
  async getAccountSummary() {
    this._accountSummary = {};
    const reqId = 1;
    this.ib.reqAccountSummary(reqId, 'All', 'NetLiquidation,AvailableFunds,BuyingPower');
    await new Promise((r) => setTimeout(r, 2000));
    try { this.ib.cancelAccountSummary(reqId); } catch (e) { /* noop */ }
    const num = (t) => Number(this._accountSummary[t]?.value) || 0;
    return {
      netLiquidation: num('NetLiquidation'),
      availableFunds: num('AvailableFunds'),
      buyingPower: num('BuyingPower'),
    };
  }

  // ---- 今天是否開盤（用 SPY 的交易時段判斷）-----------------------------
  isMarketOpenToday() {
    return new Promise((resolve) => {
      const reqId = this._reqId();
      const contract = { symbol: 'SPY', secType: 'STK', exchange: 'SMART', currency: 'USD' };
      let done = false;
      const finish = (val) => {
        if (done) return; done = true;
        this.ib.removeListener(EventName.contractDetails, onDetails);
        this.ib.removeListener(EventName.contractDetailsEnd, onEnd);
        clearTimeout(timer);
        resolve(val);
      };
      const todayStr = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date()).replace(/-/g, '');
      const onDetails = (id, details) => {
        if (id !== reqId || !details?.liquidHours) return;
        // liquidHours 形如 "20260718:0930-20260718:1600;20260719:CLOSED"
        const open = details.liquidHours.split(';').some(
          (seg) => seg.startsWith(todayStr) && !seg.includes('CLOSED'));
        finish(open);
      };
      const onEnd = (id) => { if (id === reqId) finish(false); };
      this.ib.on(EventName.contractDetails, onDetails);
      this.ib.on(EventName.contractDetailsEnd, onEnd);
      this.ib.reqContractDetails(reqId, contract);
      const timer = setTimeout(() => finish(false), 6000);
    });
  }

  // 決定這次要用哪種行情：
  //   數字(1/2/3/4) → 就用它；'auto' → 先試即時(1)，拿不到就自動退回延遲(3)。
  // 結果記在 this._activeMdt，之後查 greeks 直接複用，不用每檔重試。
  _mdt() {
    if (this._activeMdt != null) return this._activeMdt;
    if (this.marketDataType !== 'auto') return this.marketDataType;
    return 3; // auto 尚未探測出來前，先當延遲用
  }

  // ---- SPX 現價 ---------------------------------------------------------
  async getSpxPrice(timeoutMs = 6000) {
    // auto 模式：第一次呼叫先探測即時行情能不能用
    if (this.marketDataType === 'auto' && this._activeMdt == null) {
      try {
        const p = await this._fetchSpx(1, 4000); // 試即時
        this._activeMdt = 1;
        this.log('📡 使用即時行情');
        return p;
      } catch (e) {
        this._activeMdt = 3;                     // 沒訂閱 → 退回延遲
        this.log('⚠️  偵測到沒有即時行情訂閱，改用延遲報價，繼續執行');
      }
    }
    return this._fetchSpx(this._mdt(), timeoutMs);
  }

  _fetchSpx(mdt, timeoutMs) {
    return new Promise((resolve, reject) => {
      const reqId = this._reqId();
      const contract = { symbol: 'SPX', secType: 'IND', exchange: 'CBOE', currency: 'USD' };
      let done = false;
      const finish = (val, err) => {
        if (done) return; done = true;
        try { this.ib.cancelMktData(reqId); } catch (e) { /* noop */ }
        this.ib.removeListener(EventName.tickPrice, onTick);
        clearTimeout(timer);
        err ? reject(err) : resolve(val);
      };
      // tickType: 4=Last 68=DelayedLast 9=Close 72=DelayedClose 1=Bid 2=Ask
      const onTick = (id, tickType, price) => {
        if (id !== reqId || !(price > 0)) return;
        if ([4, 68, 9, 72, 1, 2, 66, 67].includes(tickType)) finish(price);
      };
      this.ib.on(EventName.tickPrice, onTick);
      this.ib.reqMarketDataType(mdt);
      this.ib.reqMktData(reqId, contract, '', false, false);
      const timer = setTimeout(() => finish(null, new Error('取得 SPX 現價逾時')), timeoutMs);
    });
  }

  // 先問出 SPX 指數的 conId（查選擇權參數需要它）
  _resolveSpxConId() {
    return new Promise((resolve) => {
      const reqId = this._reqId();
      const contract = { symbol: 'SPX', secType: 'IND', exchange: 'CBOE', currency: 'USD' };
      let done = false;
      const finish = (val) => {
        if (done) return; done = true;
        this.ib.removeListener(EventName.contractDetails, onDetails);
        this.ib.removeListener(EventName.contractDetailsEnd, onEnd);
        clearTimeout(timer);
        resolve(val);
      };
      const onDetails = (id, details) => {
        if (id === reqId && details?.contract?.conId) finish(details.contract.conId);
      };
      const onEnd = (id) => { if (id === reqId) finish(0); };
      this.ib.on(EventName.contractDetails, onDetails);
      this.ib.on(EventName.contractDetailsEnd, onEnd);
      this.ib.reqContractDetails(reqId, contract);
      const timer = setTimeout(() => finish(0), 6000);
    });
  }

  // ---- 找下一個 SPXW 到期日（>= minDte 天）------------------------------
  async getNextExpiry(minDte = 1) {
    const conId = await this._resolveSpxConId();
    if (!conId) throw new Error('無法解析 SPX 指數的 conId');
    return new Promise((resolve, reject) => {
      const reqId = this._reqId();
      let expirations = [];
      let done = false;
      const finish = (err) => {
        if (done) return; done = true;
        this.ib.removeListener(EventName.securityDefinitionOptionParameter, onParam);
        this.ib.removeListener(EventName.securityDefinitionOptionParameterEnd, onEnd);
        clearTimeout(timer);
        if (err) return reject(err);
        const uniq = [...new Set(expirations)].sort();
        const todayNY = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(new Date()).replace(/-/g, '');
        const future = uniq.filter((e) => (minDte <= 0 ? e >= todayNY : e > todayNY));
        const pick = future[0]; // 最近的未來到期日（1DTE 就是隔日那張）
        pick ? resolve(pick) : reject(new Error('查不到可用的 SPXW 到期日'));
      };
      const onParam = (id, exch, underlyingConId, tradingClass, multiplier, expiries) => {
        if (id !== reqId || tradingClass !== 'SPXW') return;
        expirations = expirations.concat(expiries);
      };
      const onEnd = (id) => { if (id === reqId) finish(); };
      this.ib.on(EventName.securityDefinitionOptionParameter, onParam);
      this.ib.on(EventName.securityDefinitionOptionParameterEnd, onEnd);
      this.ib.reqSecDefOptParams(reqId, 'SPX', '', 'IND', conId);
      const timer = setTimeout(() => {
        if (expirations.length) finish();
        else finish(new Error('查詢 SPXW 到期日逾時'));
      }, 8000);
    });
  }

  // ---- 依 delta 挑一檔 put ---------------------------------------------
  // 回傳離 targetDelta 最近的合約 { strike, delta(0~1), bid, ask, mid }，查不到回 null
  async findPutByDelta(expiry, spxPrice, targetDelta) {
    const candidates = await this._listPutContracts(expiry, spxPrice);
    if (!candidates.length) return null;
    const quoted = await this._fetchGreeks(candidates);
    if (!quoted.length) return null;
    quoted.sort((a, b) => Math.abs(a.delta - targetDelta) - Math.abs(b.delta - targetDelta));
    return quoted[0];
  }

  // 取得某到期日、現價附近的 put 合約清單（5 點間距，往下 350 點往上 50 點）
  _listPutContracts(expiry, spxPrice) {
    return new Promise((resolve, reject) => {
      const reqId = this._reqId();
      const minStrike = spxPrice - 350;
      const maxStrike = spxPrice + 50;
      const contract = {
        symbol: 'SPX', secType: 'OPT', exchange: 'SMART', currency: 'USD',
        tradingClass: 'SPXW', right: 'P', lastTradeDateOrContractMonth: expiry, multiplier: 100,
      };
      const chain = [];
      let done = false;
      const finish = (err) => {
        if (done) return; done = true;
        this.ib.removeListener(EventName.contractDetails, onDetails);
        this.ib.removeListener(EventName.contractDetailsEnd, onEnd);
        clearTimeout(timer);
        if (err) return reject(err);
        const out = chain.filter((c) =>
          c.strike >= minStrike && c.strike <= maxStrike && c.strike % 5 === 0);
        resolve(out);
      };
      const onDetails = (id, details) => {
        if (id !== reqId) return;
        const c = details.contract || details;
        if (c && c.strike !== undefined) chain.push(c);
      };
      const onEnd = (id) => { if (id === reqId) finish(); };
      this.ib.on(EventName.contractDetails, onDetails);
      this.ib.on(EventName.contractDetailsEnd, onEnd);
      this.ib.reqContractDetails(reqId, contract);
      const timer = setTimeout(() => finish(new Error('取得 SPX 選擇權鏈逾時')), 12000);
    });
  }

  // 對每檔合約要 delta + bid/ask，回傳有完整報價的 { strike, delta(0~1), bid, ask, mid }
  async _fetchGreeks(contracts) {
    const results = [];
    const one = (c) => new Promise((resolve) => {
      const reqId = this._reqId();
      const rec = { strike: c.strike, delta: 0, bid: 0, ask: 0 };
      let done = false;
      const finish = () => {
        if (done) return; done = true;
        try { this.ib.cancelMktData(reqId); } catch (e) { /* noop */ }
        this.ib.removeListener(EventName.tickPrice, onTick);
        this.ib.removeListener(EventName.tickOptionComputation, onGreek);
        clearTimeout(timer);
        if (rec.delta > 0 && rec.bid > 0 && rec.ask > 0) {
          resolve({ strike: rec.strike, delta: rec.delta, bid: rec.bid, ask: rec.ask, mid: (rec.bid + rec.ask) / 2 });
        } else {
          resolve(null);
        }
      };
      const maybeDone = () => { if (rec.delta > 0 && rec.bid > 0 && rec.ask > 0) finish(); };
      const onTick = (id, tickType, val) => {
        if (id !== reqId) return;
        if (tickType === 1 || tickType === 66) { rec.bid = val; maybeDone(); }
        if (tickType === 2 || tickType === 67) { rec.ask = val; maybeDone(); }
      };
      const onGreek = (id, tickType, iv, delta) => {
        if (id !== reqId) return;
        if (delta != null && Math.abs(delta) > 0 && Math.abs(delta) <= 1) { rec.delta = Math.abs(delta); maybeDone(); }
      };
      this.ib.on(EventName.tickPrice, onTick);
      this.ib.on(EventName.tickOptionComputation, onGreek);
      this.ib.reqMarketDataType(this._mdt());
      this.ib.reqMktData(reqId, {
        symbol: 'SPX', secType: 'OPT', exchange: 'SMART', currency: 'USD',
        tradingClass: c.tradingClass || 'SPXW', right: 'P',
        lastTradeDateOrContractMonth: c.lastTradeDateOrContractMonth || c.expiry,
        strike: c.strike, multiplier: 100,
      }, '106', false, false);
      const timer = setTimeout(finish, 3500);
    });

    // 一次最多同時要 12 檔，避免打穿 IBKR 的速率限制
    const MAX = 12;
    let i = 0;
    const worker = async () => {
      while (i < contracts.length) {
        const c = contracts[i++];
        const r = await one(c);
        if (r) results.push(r);
        await new Promise((res) => setTimeout(res, 20));
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX, contracts.length) }, worker));
    return results;
  }

  // ---- 賣 put + 掛好自動停利（母子單）----------------------------------
  // 母單：SELL LMT @ entryPrice（賣出建倉）
  // 子單：BUY  LMT @ tpPrice   （tif=GTC，權利金跌到這裡自動買回鎖利）
  // 兩張一起送出去，之後 IBKR 幫你顧，程式可以直接關掉。
  sellPutWithStandingTP(expiry, strike, quantity, entryPrice, tpPrice, dryRun = false) {
    if (this._nextId == null) throw new Error('尚未取得訂單序號，無法下單');
    const parentId = this._nextId++;
    const childId = this._nextId++;

    const contract = {
      symbol: 'SPX', secType: 'OPT', exchange: 'SMART', currency: 'USD',
      tradingClass: 'SPXW', right: 'P', lastTradeDateOrContractMonth: expiry,
      strike, multiplier: 100,
    };
    const sell = {
      orderId: parentId, action: 'SELL', orderType: 'LMT',
      lmtPrice: fmtPrice(entryPrice), totalQuantity: quantity, transmit: false,
    };
    const takeProfit = {
      orderId: childId, parentId, action: 'BUY', orderType: 'LMT',
      lmtPrice: fmtPrice(tpPrice), totalQuantity: quantity, tif: 'GTC', transmit: true,
    };

    if (dryRun) {
      this.log(`[乾跑] 賣 SPXW ${expiry} ${strike}P x${quantity} @ $${fmtPrice(entryPrice)} ｜ 停利買回 @ $${fmtPrice(tpPrice)}`);
      return { parentId, childId };
    }
    this.ib.placeOrder(parentId, contract, sell);
    this.ib.placeOrder(childId, contract, takeProfit);
    return { parentId, childId };
  }
}

// SPX 選擇權跳動點：>= $3 用 0.10，< $3 用 0.05
function fmtPrice(price) {
  if (!price || price <= 0) return 0;
  const grid = price >= 3.0 ? 0.10 : 0.05;
  return Number((Math.round(price / grid) * grid).toFixed(2));
}

module.exports = { IBKRBroker, fmtPrice };
