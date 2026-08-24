import Log from '../util/Log';
"use strict";

import axios from 'axios';
import sha256 from 'crypto-js';
import fs from 'fs';
import path from 'path';

import Config from './config';
import WS from './WebSocket'
import MockAPI from './MockAPI';
import { MOCK_BROKER, MOCK_QUOTES } from '../constants';

// __dirname-relative (repo root), matching ANT's/Zerodha's session file
// resolution - previously a bare 'userToken.txt' resolved against
// process.cwd(), which silently broke if any two processes launched from
// different working directories (see src/orchestrator.ts's explicit cwd fix).
const TOKEN_FILE = path.join(__dirname, '../../userToken.txt');

class NorenRestApi {


  //Karthik
  userId = 'FA96552'
  passwd = 'Api@1237'
  vendorCode = 'FA96552_U'
  imei = 'abc1234'
  clientId = 'FA96552_U'
  secretCode = 'jdp7x50aI14alydpaGIiC1am0xxxbrnfRq1nRE361iRarAr5359jmdMxxdaomga5'
  otpRequest = {"uid":"FA96552","pan":"d6fca95415e3d0091d8bb888648246e4cf3b17f65e66405f0e20612736182679"}

  endpoint = 'test';
  userToken = '';   // susertoken — used as Bearer token for REST and WebSocket auth
  accessToken = ''; // alias kept for clarity; same value as userToken after login
  websocket: WS;


  private routes = {
    'authorize': 'QuickAuth',
    'gen_acs_tok': 'GenAcsTok',
    'logout': '/Logout',
    'forgot_password': '/ForgotPassword',
    'watchlist_names': '/MWList',
    'watchlist': '/MarketWatch',
    'watchlist_add': '/AddMultiScripsToMW',
    'watchlist_delete': '/DeleteMultiMWScrips',
    'placeorder': '/PlaceOrder',
    'modifyorder': '/ModifyOrder',
    'cancelorder': '/CancelOrder',
    'exitorder': '/ExitSNOOrder',
    'orderbook': '/OrderBook',
    'tradebook': '/TradeBook',
    'singleorderhistory': '/SingleOrdHist',
    'searchscrip': '/SearchScrip',
    'TPSeries': '/TPSeries',
    'optionchain': '/GetOptionChain',
    'holdings': '/Holdings',
    'limits': '/Limits',
    'positions': '/PositionBook',
    'scripinfo': '/GetSecurityInfo',
    'getquotes': '/GetQuotes',
  }

  constructor() {
    this.endpoint = Config.endpoint;

    this.reloadToken();

    axios.interceptors.request.use(req => {
      console.log(`[REQ] ${req.method?.toUpperCase()} ${req.url}`, req.data);
      return req;
    });
    
    axios.interceptors.response.use(response => {
      console.log(`[RES] ${response.status} ${response.config.url}`, response.data);
      if (response.status === 200) {
        if (response.data.success || response.data.status) {
          return response.data;
        } else {
          return response.data;
        }
      }
    }, error => {
      console.log(`[ERR] ${error.config?.url}`, error.response?.data ?? error.message);
      Log.log(error)
      // ... rest of error handling
    });
    


  }

  // Public re-read hook: `order` calls this after `frontend` completes a fresh
  // OAuth login in a different process, so this already-running singleton picks
  // up the new token without a restart (see reloadSession in orderProcess.ts).
  reloadToken = () => {
    if (fs.existsSync(TOKEN_FILE)) {
      const savedToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
      if (savedToken) {
        this.userToken = savedToken;
        this.accessToken = savedToken;
        Log.log('Restored Shoonya access token from userToken.txt');
      }
    }
  }

  getUserToken = async () => {
    const { readFile } = require('fs/promises')
    const userToken = readFile(TOKEN_FILE, 'utf8')
    return userToken;
  }

  setUserToken = async (token) => {
    const { writeFile } = require('fs/promises')
    Log.log('Writing token ', token)
    await writeFile(TOKEN_FILE, token);
  }

  post_request = async (route, params) => {
    const url = this.endpoint + this.routes[route];
    const payload = 'jData=' + JSON.stringify(params);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json; charset=utf-8'
    };
    const noAuthRoutes = ['authorize', 'gen_acs_tok'];
    if (!noAuthRoutes.includes(route) && this.accessToken) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
    }
    return axios.post(url, payload, { headers });
  }

  request_otp = () => {
    if (MOCK_BROKER) {
      Log.log('[RestAPI] Mock request_otp (no-op)');
      return Promise.resolve({ stat: 'Ok' });
    }
    const url = 'https://trade.shoonya.com/NorenWClientWeb/FgtPwdOTP';
    const payload = 'jData=' + JSON.stringify(this.otpRequest);
    return axios.post(url, payload);
  }

  logout = async () => {
    if (MOCK_BROKER) {
      Log.log('[RestAPI] Mock logout (no-op)');
      return;
    }
    await this.post_request('logout', this.userId);
    Log.log('Logged out')
  }
  getOAuthURL = () => {
    return `https://api.shoonya.com/OAuthlogin/authorize/oauth?client_id=${this.clientId}`;
  }

  loginWithGenAcsTok = async (code: string) => {
    if (MOCK_BROKER) {
      Log.log('[RestAPI] Mock login with GenAcsTok (no-op)');
      this.accessToken = 'mock-token';
      return this.accessToken;
    }

    // checksum = sha256(client_id + secret_code + auth_code), per Shoonya's
    // NorenRestApiOAuth reference client — no appkey/client_secret in the payload.
    const checksum = sha256.SHA256(`${this.clientId}${this.secretCode}${code}`).toString();

    const authparams = {
      code: code,
      checksum: checksum,
      uid: this.userId
    };

    try {
      const auth_data: any = await this.post_request('gen_acs_tok', authparams);
      Log.log('GenAcsTok Auth Data: ', auth_data);
      this.userToken = auth_data.susertoken;
      this.accessToken = auth_data.access_token || this.userToken;
      this.userId = auth_data.actid || auth_data.USERID || this.userId;
      await this.setUserToken(this.accessToken);
      return this.accessToken;
    } catch (e) {
      Log.log('GenAcsTok login error: ', e);
      throw e;
    }
  };

  login = async (otp: string) => {
    if (MOCK_BROKER) {
      Log.log('[RestAPI] Mock login (no-op)');
      this.accessToken = 'mock-token';
      return this.accessToken;
    }

    const pwd = sha256.SHA256(this.passwd).toString();
    // New appkey format: SHA256(clientId + secretCode) replacing old SHA256(userId|apiKey)
    const appkey = sha256.SHA256(`${this.clientId}${this.secretCode}`).toString();

    const authparams = {
      source: 'API',
      apkversion: 'js:1.0.0',
      uid: this.userId,
      pwd: pwd,
      factor2: otp,
      vc: this.vendorCode,
      appkey: appkey,
      imei: this.imei
    };

    try {
      const auth_data: any = await this.post_request('authorize', authparams);
      Log.log('Auth Data: ', auth_data);
      this.userToken = auth_data.susertoken;
      this.accessToken = this.userToken;
      this.userId = auth_data.actid || this.userId;
      await this.setUserToken(this.userToken);
      return this.accessToken;
    } catch (e) {
      Log.log('Error: ', e);
      throw e;
    }
  };



  /**
       * Description
       * @method searchscrip
       * @param {string} exchange
       * @param {string} searchtext
       */

  searchscrip = async (searchtext) => {

    Log.log('searchtext: ', searchtext);
    let values = {};
    values["uid"] = this.userId;
    values["exch"] = 'NFO';
    values["stext"] = searchtext;

    let reply = await this.post_request("searchscrip", values);
    return reply.data.token;
  };

  /**
       * Description
       * @method get_quotes
       * @param {string} exchange
       * @param {string} token
       */

  get_quotes = (exchange, token) => {
    if (MOCK_BROKER && MOCK_QUOTES) {
      return MockAPI.get_quotes(exchange, token);
    }

    let values = {}
    values["uid"] = this.userId
    values["exch"] = exchange
    values["token"] = token

    let reply = this.post_request("getquotes", values);
    return reply;
  };

  /**
       * Description
       * @method get_time_price_series
       * @param {string} exchange
       * @param {string} token
       * @param {string} starttime
       * @param {string} endtime
       * @param {string} interval
       */

  get_time_price_series = function (params) {

    let values = {}
    values["uid"] = this.username;
    values["exch"] = params.exchange;
    values["token"] = params.token;
    values["st"] = params.starttime;
    if (params.endtime !== undefined)
      values["et"] = params.endtime;
    if (params.interval !== undefined)
      values["intrv"] = params.interval;

    let reply = this.post_request("TPSeries", values, this.usertoken);
    return reply;
  };

  /**
       * Description
       * @method place_order
       * @param {string} buy_or_sell
       * @param {string} product_type
       */
  place_order = async (order) => {
    if (MOCK_BROKER) {
      return MockAPI.place_order(order);
    }
    let values = { 'ordersource': 'API' };
    values["uid"] = this.userId;
    values["actid"] = this.userId;
    values["trantype"] = order.trantype;
    values["prd"] = order.prd;
    values["exch"] = order.exch;
    values["tsym"] = order.tsym;
    values["qty"] = order.qty.toString();
    // values["dscqty"] = order.discloseqty.toString();
    values["prctyp"] = order.prctyp
    values["prc"] = order.prc.toString();
    // values["remarks"] = order.remarks;

    // if (order.amo !== undefined)
    //   values["ret"] = order.retention;
    // else
    values["ret"] = 'DAY';

    // if (order.trigger_price !== undefined)
    //   values["trgprc"] = order.trigger_price.toString();

    // if (order.amo !== undefined)
    //   values["amo"] = order.amo;

    //if cover order or high leverage order
    // if (order.product_type == 'H') {
    //   values["blprc"] = order.bookloss_price.toString();
    //   //trailing price
    //   if (order.trail_price != 0.0) {
    //     values["trailprc"] = order.trail_price.toString();
    //   }
    // }
    // //bracket order
    // if (order.product_type == 'B') {
    //   values["blprc"] = order.bookloss_price.toString();
    //   values["bpprc"] = order.bookprofit_price.toString();
    //   //trailing price
    //   if (order.trail_price != 0.0) {
    //     values["trailprc"] = order.trail_price.toString();
    //   }
    // }

    let reply = this.post_request("placeorder", values);
    // return 'Order NOT PLACED';
    return reply

  };

  option_chain = async (ltp) => {
    let values = { };
    values["uid"] = this.userId;
    values["tsym"] = 'NIFTY31JUL25F';
    values["exch"] = 'NFO'
    values["strprc"] = ltp
    values["cnt"] = "1";

    let reply = this.post_request("optionchain", values);
    Log.log('Reply: ', reply)
    return reply;

  };


  /**
       * Description
       * @method modify_order
       * @param {string} orderno
       * @param {string} exchange
       * @param {string} tradingsymbol
       * @param {integer} newquantity
       * @param {string} newprice_type
       * @param {integer} newprice
       * @param {integer} newtrigger_price
       * @param {integer} bookloss_price
       * @param {integer} bookprofit_price
       * @param {integer} trail_price
       */

  modify_order = function (modifyparams) {
    if (MOCK_BROKER) {
      Log.log('[RestAPI] Mock modify_order (no-op)');
      return Promise.resolve({ stat: 'Ok' });
    }

    let values = { 'ordersource': 'API' };
    values["uid"] = this.userId;
    values["actid"] = this.accountid;
    values["norenordno"] = modifyparams.orderno;
    values["exch"] = 'NFO';
    values["tsym"] = modifyparams.tsym;
    values["qty"] = modifyparams.quantity.toString();
    values["prctyp"] = 'LMT';
    values["prc"] = modifyparams.price.toString();

    // if ((modifyparams.newprice_type == 'SL-LMT') || (modifyparams.newprice_type == 'SL-MKT')) {
    //   values["trgprc"] = modifyparams.newtrigger_price.toString();
    // }

    // //#if cover order or high leverage order
    // if (modifyparams.bookloss_price !== undefined) {
    //   values["blprc"] = modifyparams.bookloss_price.toString();
    // }
    // //#trailing price
    // if (modifyparams.trail_price !== undefined) {
    //   values["trailprc"] = modifyparams.trail_price.toString();
    // }
    // //#book profit of bracket order   
    // if (modifyparams.bookprofit_price !== undefined) {
    //   values["bpprc"] = modifyparams.bookprofit_price.toString();
    // }

    let reply = this.post_request("modifyorder", values);
    return reply;
  };

  /**
       * Description
       * @method cancel_order
       * @param {string} orderno     
       */

  cancel_order = function (orderno) {
    if (MOCK_BROKER) {
      Log.log(`[RestAPI] Mock cancel_order ${orderno} (no-op)`);
      return Promise.resolve({ stat: 'Ok' });
    }

    let values = { 'ordersource': 'API' };
    values["uid"] = this.userId;
    values["norenordno"] = orderno;

    let reply = this.post_request("cancelorder", values);
    return reply;
  };
  /**
       * Description
       * @method exit_order
       * @param {string} orderno
       * @param {string} product_type
       */

  exit_order = function (orderno, product_type) {

    let values = {};
    values["uid"] = this.username;
    values["norenordno"] = orderno;
    values["prd"] = product_type;

    let reply = this.post_request("exitorder", values);
    return reply;
  };
  /**
       * Description
       * @method get_orderbook
       * @param no params
       */

  get_orderbook = async function () {
    if (MOCK_BROKER) {
      return [];
    }

    let values = {};
    values["uid"] = this.userId;

    let reply = this.post_request("orderbook", values);
    return reply;
  };
  /**
       * Description
       * @method get_tradebook
       * @param no params
       */

  get_tradebook = async () => {
    if (MOCK_BROKER) {
      return [];
    }

    let values = {};
    values["uid"] = this.userId;
    values["actid"] = this.userId;

    let reply = this.post_request("tradebook", values);
    return reply;
  };
  /**
       * Description
       * @method get_holdings
       * @param product_type
       */

  get_holdings = function (product_type = 'C') {

    let values = {};
    values["uid"] = this.username;
    values["actid"] = this.accountid;
    values["prd"] = product_type;

    let reply = this.post_request("holdings", values);
    return reply;
  };
  /**
       * Description
       * @method get_positions
       * @param no params
       */

  get_positions = () => {
    if (MOCK_BROKER) {
      return Promise.resolve([]);
    }

    let values = {};
    values["uid"] = this.userId;
    values["actid"] = this.userId;

    let reply = this.post_request("positions", values);
    return reply;
  };
  /**
       * Description
       * @method get_limits
       * @param optional params
       */

  get_limits = function (product_type = '', segment = '', exchange = '') {

    let values = {};
    values["uid"] = this.username;
    values["actid"] = this.accountid;

    if (product_type != '') {
      values["prd"] = product_type
    }

    if (product_type != '') {
      values["seg"] = segment
    }

    if (exchange != '') {
      values["exch"] = exchange
    }

    let reply = this.post_request("limits", values);
    return reply;
  };
  /**
       * Description
       * @method start_websocket
       * @param no params
       */
  start_websocket = async (callbacks) => {
    // Always give MockAPI the callbacks so place_order can fire order fills
    if (MOCK_BROKER) {
      MockAPI.setCallbacks(callbacks);
      if (MOCK_QUOTES) {
        Log.log('[RestAPI] Mock WebSocket — starting mock streams');
        await MockAPI.startMockStreams();
        setTimeout(() => callbacks.socket_open({ msg: 'mock connection open' }), 100);
        return;
      }
      // Option A: real WS continues below but mock callbacks are stored
    }

    if (!this.websocket) {
      const userToken = await this.getUserToken();

      this.websocket = new WS({ 'url': Config.websocket, 'apikey': userToken});

      let params = {
        'uid': this.userId,
        'actid': this.userId,
        'apikey': userToken,
      }

      this.websocket.connect(params, callbacks)
        .then(() => {
          Log.log('ws is connected');
        });

    }

  };

}

export default new NorenRestApi();
// module.exports = NorenRestApi;