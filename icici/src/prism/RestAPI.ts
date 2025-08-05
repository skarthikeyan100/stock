"use strict";

import axios from 'axios';
import sha256 from 'crypto-js';

import Config from './config';
import WS from './WebSocket'

class NorenRestApi {


  //Karthik
  userId = 'FA96552'
  passwd = 'Api@128'
  vendorCode = 'FA96552_U'
  imei = 'abc1234'
  apiKey = 'cac8568d15187897a1a38209da48c1fe'
  twoFA = '78601'
  otpRequest = {"uid":"FA96552","pan":"3ca672c1a0717120ef3035b90ad6a9f6591783970b361784fbcd91435d666ac4"}


  //Raja //AJAPR6032J
  // userId = 'FA396690'
  // passwd = 'SRaja@72'
  // vendorCode = 'FA396690_U'
  // imei = 'abc1234'
  // apiKey = 'b29b6326ad9282d0b2aa80e49843d26c'
  // twoFA = '78601'
  // otpRequest = {"uid":"FA396690","pan":"344e0e2df4e870bfc2a28403817fa32e88981fb2dfcd1116c35406d088c91566"}

  endpoint = 'test';
  userToken = '9d388557d894a8137d4c1663f8b41dd32801b36e68ecebef177c24f082f0bcd1';
  websocket: WS;


  private routes = {
    'authorize': '/QuickAuth',
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

    axios.interceptors.request.use(req => {
      console.log("use::", `${req.method} ${req.url} ${req.data}`);
      // Important: request interceptors **must** return the request.
      return req;
    });

    // Add a response interceptor
    axios.interceptors.response.use(response => {
      if (Config.debug == true) {
        console.log("response::", response)
      }
      if (response.status === 200) {
        if (response.data.success || response.data.status) {
          return response.data;
        } else {
          return response.data;
        }
      }
    }, error => {
      console.log(error)
      let errorObj = {} as any;

      if (error.response) {
        //    errorObj.status = error.response.status;
        //    errorObj.message = error.response.statusText;
      } else {
        errorObj.status = 500;
        errorObj.message = "Error";
      }

      return Promise.reject(errorObj);
    });

  }

  getUserToken = async () => {
    const { readFile } = require('fs/promises')
    const userToken = readFile('userToken.txt', 'utf8')
    return userToken;
  }

  setUserToken = async (token) => {
    const { writeFile } = require('fs/promises')
    console.log('Writing token ', token)
    await writeFile("userToken.txt", token);
  }

  post_request = async (route, params) => {
    let url = this.endpoint + this.routes[route];
    let payload = 'jData=' + JSON.stringify(params);
    //if(usertoken.isEmpty == false)
    const userToken = await this.getUserToken();
    payload = payload + `&jKey=${userToken}`;
    return axios.post(url, payload);

    //return requestInstance.request(options);
  }

  request_otp = () => {
    let url = 'https://trade.shoonya.com/NorenWClientWeb/FgtPwdOTP';

    
    let payload = 'jData=' + JSON.stringify(this.otpRequest);
    return axios.post(url, payload);
  }

  setSessionDetails = (response) => {
    this.userToken = response.susertoken;
    this.userId = response.actid
    this.setUserToken(this.userToken);

  };

  logout = async () => {
    await this.post_request('logout', this.userId);
    console.log('Logged out')
  }
  /**
    * Description
    * @method login
    * @param {string} userid
    * @param {string} password
    * @param {string} twoFA
    * @param {string} vendor_code
    * @param {string} api_secret
    * @param {string} imei
    */

  login = async (twoFA) => {

    let pwd = sha256.SHA256(this.passwd).toString();
    let u_app_key = `${this.userId}|${this.apiKey}`
    let app_key = sha256.SHA256(u_app_key).toString();

    let authparams = {
      "source": "API",
      "apkversion": "js:1.0.0",
      "uid": this.userId,
      "pwd": pwd,
      "factor2": twoFA,
      "vc": this.vendorCode,
      "appkey": app_key,
      "imei": this.imei
    };

    try {
      let auth_data = await this.post_request("authorize", authparams);
      console.log("Auth Data: ", auth_data);
      this.setSessionDetails(auth_data);
      return this.userToken;
    } catch (e) {
      console.log('Error: ', e);
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

    console.log('searchtext: ', searchtext);
    let values = {};
    values["uid"] = this.userId;
    values["exch"] = 'NFO';
    values["stext"] = searchtext;

    let reply = await this.post_request("searchscrip", values);
    console.log(reply);
    return reply.data.token;
  };

  /**
       * Description
       * @method get_quotes
       * @param {string} exchange
       * @param {string} token
       */

  get_quotes = (exchange, token) => {

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
    return reply;

  };

  option_chain = async (ltp) => {
    let values = { };
    values["uid"] = this.userId;
    values["tsym"] = 'NIFTY31JUL25F';
    values["exch"] = 'NFO'
    values["strprc"] = ltp
    values["cnt"] = "1";

    let reply = this.post_request("optionchain", values);
    console.log('Reply: ', reply)
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
          console.log('ws is connected');
        });
  
    }

  };

  subscribe = async (instrument) => {
    let values = {};
    values['t'] = 't';  //touchline
    // values['t'] = 'd'; //depth 
    values['k'] = instrument
    console.log('Subscribing to ', JSON.stringify(values))
    await this.websocket.send(JSON.stringify(values));
  }

  unsubscribe = (instrument) => {
    let values = {};
    values['t'] = 'u';
    // values['t'] = 'ud';  //depth
    values['k'] = instrument
    console.log('Unsubscribing ', JSON.stringify(values))
    this.websocket.send(JSON.stringify(values));
  }
}

export default new NorenRestApi();
// module.exports = NorenRestApi;