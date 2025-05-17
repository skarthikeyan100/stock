import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:cbse/main.dart';
import 'package:cbse/util/api_util.dart';

import '../service/service.dart';

enum SettingsKey {
  host, depth, lotSize, targetPrice
}
class SettingsState {
  int depth = 0;
  int lotSize = 10;
  late String host;
  String otp = '1234';
  int targetPrice = 0;

  SettingsState() {
    host = settingsDb.getString(SettingsKey.host.name, defaultValue: '192.168.0.113');
    depth = settingsDb.getNumber(SettingsKey.depth.name, defaultValue: 2).toInt();
    lotSize = settingsDb.getNumber(SettingsKey.lotSize.name, defaultValue: 4).toInt();
  }

  SettingsState copy() {
    SettingsState newState = SettingsState();
    newState.lotSize = lotSize;
    newState.depth = depth;
    newState.host = host;
    newState.otp = otp;
    return newState;
  }

  @override
  String toString() {
    return 'Settings: { depth: $depth, lotSize: $lotSize, host: $host, otp: $otp}';
  }
}

class SettingsStateNotifier extends StateNotifier<SettingsState> {
  SettingsStateNotifier() : super(SettingsState());

  setLotSize(int lotSize) {
    SettingsState newState = state.copy();
    newState.lotSize = lotSize;
    settingsDb.setNumber(SettingsKey.lotSize.name, lotSize);
    Service().setLotSize(lotSize);
    state = newState;
  }

  setDepth(int depth) {
    SettingsState newState = state.copy();
    newState.depth = depth;
    settingsDb.setNumber(SettingsKey.depth.name, depth);
    Service().setDepth(depth);
    state = newState;
  }

  setHost(String host) {
    SettingsState newState = state.copy();
    newState.host = host;
    settingsDb.setString(SettingsKey.host.name, host);
    state = newState;
  }

  setOtp(String otp) {
    SettingsState newState = state.copy();
    newState.otp = otp;
    state = newState;
  }

  void setTargetPrice(int targetPrice) {
    SettingsState newState = state.copy();
    newState.targetPrice = targetPrice;
    settingsDb.setNumber(SettingsKey.targetPrice.name, targetPrice);
    Service().setTargetPrice(targetPrice);
    state = newState;
  }
}

final settingsProvider =
    StateNotifierProvider<SettingsStateNotifier, SettingsState>(
        (ref) => SettingsStateNotifier());
