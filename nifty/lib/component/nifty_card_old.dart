import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:cbse/provider/trade_service_provider.dart';

import '../provider/nifty_provider.dart';
import '../provider/position_provider.dart';
import '../provider/position_provider_old.dart';
import '../provider/state/nifty_state.dart';

class NiftyCard extends ConsumerWidget {

  const NiftyCard({Key? key}) : super(key: key);

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    NiftyState data = ref.watch(niftyProvider);
    TradeServiceNotifier positionNotifier =
        ref.read(tradeServiceProvider.notifier);
    return _getScreenWidget(context, data, positionNotifier);
        
  }

  Widget _getScreenWidget(context, data, 
      TradeServiceNotifier positionNotifier) {
    return _getNiftyCard(context, data, positionNotifier);
  }

  Card _getNiftyCard(BuildContext context, NiftyState data,
      TradeServiceNotifier positionNotifier) {
    return Card(
        color: Color(0xFFfefffc),
        margin:
            EdgeInsets.only(left: 10.0, right: 5.0, top: 20.0, bottom: 20.0),
        elevation: 10.0,
        child: Align(
          alignment: Alignment.center,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.center,
            mainAxisAlignment: MainAxisAlignment.center,
            children: <Widget>[
              _getLtp(data),
              _getNiftyVariables(data),
            
              Padding(
                  padding: EdgeInsets.only(top: 16.0, left: 16.0, right: 16.0),
                  child:
                      getActionButtons(positionNotifier, data.niftyQuote.ltp)),
            ],
          ),
        ));
  }

  Widget _getLtp(NiftyState data) {
    Color color = (data.change.startsWith('-')) ? Colors.red : Colors.green;
    final TextStyle textStyle = TextStyle(fontSize: 36, color: color);
    final TextStyle textStyle1 = TextStyle(fontSize: 15, color: color);

    RichText richText = RichText(
      text: TextSpan(
        text: ' ',
        style: textStyle,
        children: <TextSpan>[
          TextSpan(
              text: data.niftyQuote.ltp.toStringAsFixed(0), style: textStyle),
          TextSpan(text: '  ( ${data.change} )', style: textStyle1),
        ],
      ),
    );
    return richText;
  }

  Widget getActionButtons(TradeServiceNotifier positionNotifier, num ltp) =>
      Row(
          crossAxisAlignment: CrossAxisAlignment.start,   
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            SizedBox(
                width: 150,
                child: ElevatedButton(
                    onPressed: () async {
                      await positionNotifier.buy('DONOTUSE', 'call');
                    },
                    child: const Text('Up'))),
            SizedBox(
                width: 150,
                child: ElevatedButton(
                    onPressed: () async {
                      await positionNotifier.buy('DONOTUSE', 'put');
                    },
                    child: const Text('Down'))),
          ]);

  Widget _getRefresh(PositionStateNotifier positionNotifier, NiftyState data) =>
      new Row(mainAxisAlignment: MainAxisAlignment.end, children: [
        Padding(
          padding: EdgeInsets.only(left: 8.0),
          child: Text(
            '${data.niftyQuote.ltt}',
          ),
        ),
      ]);

  Widget _getNiftyVariables(NiftyState data) {
    return Column(children: [
      Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Flexible(
              child: VariableCard(
            variable: 'Change From Low',
            value: data.lowVariation,
          )),
          Expanded(
              child: VariableCard(
            variable: 'To Reach High',
            value: data.highVariation,
          ))
        ],
      ),
      Row(
        children: [
          Expanded(
              child: VariableCard(
            variable: 'Change from yesterday',
            value: data.openVariation,
          )),
          Flexible(
              child: VariableCard(
            variable: 'Change from Open',
            value: data.changeVariation,
          ))
        ],
      )
    ]);
  }
}

class VariableCard extends StatelessWidget {
  const VariableCard({Key? key, required this.variable, required this.value})
      : super(key: key);
  final String variable;
  final String value;

  @override
  Widget build(BuildContext context) {
    final TextStyle variableStyle = Theme.of(context).textTheme.bodySmall!;
    final TextStyle valueStyle = Theme.of(context).textTheme.labelLarge!;
    return Card(
        child: Center(
      child: Column(children: <Widget>[
        Text(variable, style: variableStyle),
        SizedBox(height: 10),
        Text(value, style: valueStyle),
      ]),
    ));
  }
}
