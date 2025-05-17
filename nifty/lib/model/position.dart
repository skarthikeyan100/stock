import 'dart:math';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../util/util.dart';
import 'option_quote.dart';

class Position {
  late String tsym;
  late String token;
  late String stockCode;
  late String right;
  late num quantity;
  late num cost;
  late num ltp;

  Position();
  Position.create(this.tsym, this.token, this.stockCode, this.right,
      this.quantity, this.cost, this.ltp);

  Position copy() {
    print("Copying current position");
    Position p= Position.create(tsym, token, stockCode, right, quantity, cost, ltp);
    return p;
  }
  static Position fromJson(Map<String, dynamic> json) {

//data: [{"norenordno":"24102500840958","tsym":"NIFTY31OCT24C24150","quantity":25,"price":163.65,"token":"49008","action":"Buy","status":"COMPLETE","lastTradePrice":163.65,"ltp":167.2}]

print("In fromJson: $json");
    String tsym = json['tsym'];
    String token = json['token'];
    String stockCode = 'NIFTY';
    String right = tsym.contains('C') ? 'Call': 'Put';
    num quantity = Util.asnum(json['quantity']);
    num cost = Util.asnum(json['price']);
    num ltp = Util.asnum(json['ltp']);
    return Position.create(tsym, token, stockCode, right, quantity, cost, ltp);
  }

  String get profit => ((ltp - cost) * quantity).toStringAsFixed(0);

  @override
  String toString() {
    return 'tsym: $tsym token: $token Stock: $stockCode right $right quantity $quantity cost $cost ltp $ltp';
  }
}
