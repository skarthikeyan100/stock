import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../model/position.dart';
import '../service/service.dart';
import 'option_stream_provider.dart';


class TradeServiceNotifier extends StateNotifier<void> {
  TradeServiceNotifier(ref) : super(null);

  Future<void> buy(String index, String right) async {
    print('Buy is called for $index for $right');
    Service().buy(index, right);
  }

  void squareOff(String token, String right, num quantity) {
    Service().squareOff(token, right, quantity);
    print('SquareOff is called');
  }
}

final tradeServiceProvider =
    StateNotifierProvider<TradeServiceNotifier, void>(
        (ref) {
  return TradeServiceNotifier(ref);
});