/**
 * Real posts from the "Pavithra Sky Calls" channel (copied from WhatsApp Web, 2026-11-17) and, for the ones that reach
 * Claude, the structured answer the real `claude -p` returned for them (from logs/claude-parse.log).
 */
export const NIFTY_CALL =
  '*♨️RISKY JACKPOT* 🐎  *(INTRADAY)#  BUY NIFTY* (25800.00 CE) CMP 79.00 ADD UPTO 63.00 STOPLOSS 61.00 TARGET 100.00-124.00-148.00++(LOT SIZE 65)';
export const NIFTY_CALL_CLAUDE = { relevant: true, action: 'buy', instrument: 'NIFTY', strike: 25800, right: 'CE', price: 79, stop: 61, targets: [100, 124, 148] };

export const PAYTM_CALL =
  'Positional\n\nRISKY JACKPOT\n\nDATE: 12-11-2026\n\n# BUY Paytm ( NOV: 2000.00 CE) at above 20.50 ADD UPTO 17.00 STOPLOSS 17.00 TARGET 22.50-25.00-28.00++(LOT SIZE 725';
export const PAYTM_CALL_CLAUDE = { relevant: true, action: 'buy', instrument: 'PAYTM', strike: 2000, right: 'CE', price: 20.5, stop: 17, targets: [22.5, 25, 28] };

export const HAL_CALL =
  'Positional ( RESULTS BET)\n\nRISKY JACKPOT\n\nDATE: 12-11-2026\n\n# BUY HAL ( NOV: 5400.00 CE) at above 13.50 ADD UPTO 7.00 STOPLOSS 6.00 TARGET 18.00-27.00-38.00++(LOT SIZE 150)';
export const HAL_CALL_CLAUDE = { relevant: true, action: 'buy', instrument: 'HAL', strike: 5400, right: 'CE', price: 13.5, stop: 6, targets: [18, 27, 38] };

/** Profit-booking update on an earlier option call: has CE, reaches Claude, Claude says not relevant. */
export const PAYTM_BOOK_UPDATE = 'Forwarded\n# PAYTM 2000 CE: 24.25 FROM 20.50 BOOK Pls check on 12-11-2026';
export const PAYTM_BOOK_UPDATE_CLAUDE = { relevant: false };

/** The same NIFTY call re-posted: must never be traded twice. */
export const AGAIN_REPOST =
  'Again\n\nRISKY JACKPOT (INTRADAY+BTST)# BUY NIFTY (25800.00 CE) CMP 57.00 STOPLOSS 44.00 TARGET 74.00-98.00-120.00++(LOT SIZE 65)';

export const CASH_POSTS = [
  '( T+4) # BUY FEDERAL BANK (CASH) AT ABOVE 360.40 ADD UPTO 353.00 Stop 351.00 tgt 369.00-375.00-384.00++',
  '( T+4) # BUY REDINGTON (CASH) AT ABOVE 359.60 ADD UPTO 351.00 Stop 350.00 tgt 366.00-374.00-381.00++',
  '( T+4) # BUY CUPID (CASH) AT ABOVE 385.50 ADD UPTO 378.00 Stop 376.00 tgt 391.00-399.00-405.00++',
  '( T+4) # BUY MONEYVIEW (CASH) AT ABOVE 55.90 ADD UPTO 49.00 Stop 48.00 tgt 60.00-64.00-69.00++',
  '#DARKHORSESTOCKS ( T+4) # BUY OPTIEMUS (CASH) AT ABOVE 819.50 ADD UPTO 805.00 Stop 801.00 tgt 844.00-869.00-890.00++',
  'Adanipower Cash High Made 208.91\n\nUp by 3.40 Points As Of Now Hold Your Position For Target 216 And 236',
];

/** Equity update with no CE/PE and no "cash": skipped by the CE/PE rule. */
export const APOLLO_UPDATE = '# LATE UPDATE::# APOLLO :: 473.80 BUY at 457.50 pls check timeframe ( on 13-11-2026) ( CALCULATE PROFIT) BOOK (2ND TARGET DONE)';
