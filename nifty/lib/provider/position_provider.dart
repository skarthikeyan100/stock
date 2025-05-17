import 'dart:convert';

import 'package:cbse/provider/retry_provider.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:cbse/provider/state/nifty_state.dart';

import '../model/nifty_quote.dart';
import '../model/position.dart';
import '../model/position_list.dart';
import 'position_stream_provider.dart';

class PositionState {
  final List<Position> positions;

  PositionState(this.positions);

  static PositionState copy(PositionState state) {
    return PositionState([...state.positions]);
  }
}

final positionProvider = Provider<PositionState>((ref) {
  print('Building Position Provider');

  AsyncValue<dynamic> stream = ref.watch(positionStreamProvider);
  print('Watch stream');

  PositionState data = stream.when(data: (data) {
    retryCountProvider.state;

    List<Position> positions = [];

    List<dynamic> arr = json.decode(data);
    for (dynamic element in arr) {
      positions.add(Position.fromJson(element));
    }

    print('Returning positions $positions');
    ref.read(retryCountProvider.notifier).state = 0;
    return PositionState(positions);
  }, error: (error, stackTrace) {
    print('Error while fetching positions stackTrace: $stackTrace');
    // Future.microtask(() => ref.invalidate(positionStreamProvider));
    var retryCount  = ref.read(retryCountProvider.notifier).state;
    print("Retry count: $retryCount");
    if (retryCount < 3) { // Retry limit of 3
          // Delay and increment retry count before restarting
          print(' WHy in if loop');
          Future.delayed(Duration(seconds: 2), () {
            ref.read(retryCountProvider.notifier).state++;
            ref.invalidate(positionStreamProvider);
          });
        }
    return PositionState([]);
  }, loading: () {
    print('Loading positions');

    List<Position> positions = [];
    Position p1 = Position();
    p1.cost = 1000;
    p1.quantity = 10;
    p1.ltp = 1010;

    p1.token = '26000';
    p1.stockCode = 'NIFTY';
    p1.right = 'call';

    // positions.add(p1.copy());

    // p1.token = '26037';
    // positions.add(p1.copy());

    // p1.token = '26009';
    // positions.add(p1.copy());
    
    // print("Returning position state");

    return PositionState(positions);
    // return PositionState([]);
  });

  return data;
});
