import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:cbse/component/nifty_card.dart';
import 'package:cbse/component/reusable.dart';
import 'package:cbse/provider/trade_service_provider.dart';

import '../model/option_stream_data.dart';
import '../model/position.dart';
import '../provider/option_stream_provider.dart';
import '../provider/position_provider.dart';
import '../util/util.dart';

class PositionCard extends ConsumerWidget {
  static const Color seaMist = Color(0xFF464196);
  final Position position;

  const PositionCard(this.position, {Key? key}) : super(key: key);

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // debugPrint('Build Position Card');

    TradeServiceNotifier tradeServiceNotifier =
        ref.read(tradeServiceProvider.notifier);
    // return asyncValue.when(
    //     data: (data) => _getScreenWidget(context, data, notifier),
    //     loading: () => CircularProgressIndicator(),
    //     error: (e, st) => Text('Error: $e'));

    // PositionState data = asyncValue.when(data: (data) {
    //   debugPrint('Returning data: ${data.positions.length}');
    //   return data;
    // }, error: (error, stackTrace) {
    //   debugPrint("error in Monitor: $error $stackTrace");
    //   return PositionState([]);
    // }, loading: () {
    //   debugPrint("Loading positions");
    //   return PositionState([]);
    // });

    // int status = _updatePositionState(data, ref);
    // if (status == -1) {
    //   return Container();
    // }

    return _getScreenWidget(context, tradeServiceNotifier);

    // return asyncValue.whenData(
    //     (data) => _getScreenWidget(context, data, notifier));
  }

  // int _updatePositionState(PositionState state, ref) {
  //   AsyncValue<dynamic> stream = ref.watch(optionStreamProvider);

  //   int status = stream.when(data: (data) {
  //     OptionStreamData streamData =
  //         OptionStreamData.fromJson(json.decode(data));
  //     List<Position> positions = state.positions;
  //     for (Position position in positions) {
  //       if (position.token == streamData.token) {
  //         position.ltp = streamData.ltp;
  //       }
  //     }
  //     return 0;
  //   }, error: (error, stackTrace) {
  //     // if (error
  //     //     .toString()
  //     //     .startsWith("Connection closed while receiving data")) {
  //     //   print('Refresh option stream');
  //     //   ref.refresh(optionStreamProvider);
  //     // } else {
  //       print('Error in OptionStream: ${error.toString()}');
  //     //   print('option stream not refreshed');
  //     // }
  //     // print("error in Monitor: $error $stackTrace");
  //     return -1;
  //   }, loading: () {
  //     return 0;
  //   });
  //   return status;
  // }

  Widget _getScreenWidget(BuildContext context, TradeServiceNotifier notifier) {
    // debugPrint('Position Data: ${data.positions}');
    return _getPositionCard(context, position, notifier);
  }

  Widget _getRight(Position data) =>
      Row(mainAxisAlignment: MainAxisAlignment.start, children: [
        Padding(
          padding: EdgeInsets.only(left: 8.0),
          child: Text(
            data.stockCode,
            style: TextStyle(fontSize: 24),
          ),
        ),
        Padding(
          padding: EdgeInsets.only(left: 8.0),
          child: Text(
            data.right,
            style: TextStyle(fontSize: 24),
          ),
        ),
      ]);

  Card _getPositionCard(
      BuildContext context, Position data, TradeServiceNotifier notifier) {
    //TODO subtract charges
    return Card(
      color: Color(0xFFfefffc),
      margin: EdgeInsets.only(left: 10.0, right: 5.0, top: 20.0, bottom: 20.0),
      elevation: 10.0,
      shape: Reusable.radius5,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisAlignment: MainAxisAlignment.center,
        children: <Widget>[
          _getRight(data),
          _getProfit(data),
          (ElevatedButton(
              onPressed: () {
                print('Data to squareoff is $data');


                notifier.squareOff(data.tsym, data.right, data.quantity);
              },
              child: const Text(
                'Square Off',
                style: TextStyle(fontSize: 18),
              )))
        ],
      ),
    );
  }

  Widget _getProfit(Position data) {
    Color color = (data.profit.startsWith('-')) ? Colors.red : Colors.green;
    final TextStyle textStyle = TextStyle(fontSize: 36, color: color);

    RichText richText = RichText(
      text: TextSpan(
        text: 'Profit: ',
        style: textStyle,
        children: <TextSpan>[
          TextSpan(text: data.profit, style: textStyle),
        ],
      ),
    );
    return Padding(
        padding: EdgeInsets.only(top: 16, bottom: 16),
        child: Center(child: richText));
  }
}
