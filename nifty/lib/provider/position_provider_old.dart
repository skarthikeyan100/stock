import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../model/position.dart';
import '../service/service.dart';
import 'option_stream_provider.dart';

enum OrderStatus { none, ordered }

class PositionState {
  final List<Position> positions;

  PositionState(this.positions);

  static PositionState copy(PositionState state) {
    return PositionState([...state.positions]);
  }
}

class PositionStateNotifier extends StateNotifier<AsyncValue<PositionState>> {
  PositionStateNotifier(ref) : super(const AsyncValue.loading()) {
    _fetch();
  }

  Future<void> _fetch() async {
    state = const AsyncValue.loading();
    state = await AsyncValue.guard(() => _fetchPosition());
  }

  squareOff(String token, String expiryDate, String strikePrice, String right, num qty) async {
    await Service().squareOff(token, right, qty);
    _fetch();
  }

  buy(num niftyPrice, String right) async {
    await Service().buy("NIFTY", right);
    _fetch();
  }

  Future<PositionState> _fetchPosition() async {
    List<Position> positions = await Service().getOpenPositions();
    print('Positions length: ${positions.length}');
    PositionState state = PositionState(positions);
    return state;
  }

  Future<void> refresh() async {
    await Service().refreshTrades();
    PositionState newState = await _fetchPosition();
    state = AsyncValue.data(newState);
  }

  void updateLtp(String token, num ltp) {
    if (state.value != null) {
      PositionState newState = PositionState.copy(state.value!);
      List<Position> positions = newState.positions;
      for (Position position in positions) {
        if (position.token == token) {
          position.ltp = ltp;
        }
      }

      state = AsyncValue.data(newState);
    }
  }
}

final positionProviderOld =
    StateNotifierProvider<PositionStateNotifier, AsyncValue<PositionState>>(
        (ref) {
  print(' ********************  positionProvider is constructed');
  return PositionStateNotifier(ref);
});