import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../model/nifty_quote.dart';
import '../provider/index_provider.dart';
import '../provider/trade_service_provider.dart';

const textStyle = TextStyle(fontSize: 18);
Widget errorContainer = Container(
    color: Colors.red,
    height: 200,
    child: Center(
        child: Text(
      'Server Not Available',
      style: TextStyle(color: Colors.white, fontSize: 36),
    )));

class IndexCard extends ConsumerWidget {
  const IndexCard({Key? key}) : super(key: key);

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    IndexState data = ref.watch(indexProvider);
    TradeServiceNotifier tradeNotifier =
        ref.read(tradeServiceProvider.notifier);
    if (data.runtimeType.toString() == 'ErrorNiftyState') {
      return errorContainer;
    }
    return _getScreenWidget(context, data, tradeNotifier);
  }

  Widget _getScreenWidget(
      context, IndexState data, TradeServiceNotifier tradeNotifier) {
    List<Widget> cards = [];

    
    cards.add(_getNiftyCard(context, 'NIFTY', data.niftyQuote, tradeNotifier));
    cards.add(_getNiftyCard(
        context, 'BANKNIFTY', data.bankNiftyQuote, tradeNotifier));
    cards.add(
        _getNiftyCard(context, 'FINNIFTY', data.finNiftyQuote, tradeNotifier));

    return ListView(shrinkWrap: true, children: cards);
  }

  Card _getNiftyCard(BuildContext context, String index, NiftyQuote data,
      TradeServiceNotifier tradeNotifier) {
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
              _getRefresh(tradeNotifier, data),
              _getLtp(data),
              // _getNiftyVariables(data),
              Padding(
                  padding: EdgeInsets.only(top: 16.0, left: 16.0, right: 16.0),
                  child: getActionButtons(tradeNotifier, index, data.ltp)),
            ],
          ),
        ));
  }

  Widget _getLtp(NiftyQuote data) {
    Color color = (data.change.startsWith('-')) ? Colors.red : Colors.green;
    final TextStyle textStyle = TextStyle(fontSize: 36, color: color);
    final TextStyle textStyle1 = TextStyle(fontSize: 15, color: color);

    RichText richText = RichText(
      text: TextSpan(
        text: ' ',
        style: textStyle,
        children: <TextSpan>[
          TextSpan(text: data.ltp.toStringAsFixed(0), style: textStyle),
          TextSpan(text: '  ( ${data.change} )', style: textStyle1),
        ],
      ),
    );
    return richText;
  }

  Widget getActionButtons(
          TradeServiceNotifier tradeNotifier, String index, num ltp) =>
      Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            SizedBox(
                width: 150,
                child: ElevatedButton(
                    onPressed: () async {
                      await tradeNotifier.buy(index, 'call');
                    },
                    child: const Text('Up'))),
            SizedBox(
                width: 150,
                child: ElevatedButton(
                    onPressed: () async {
                      await tradeNotifier.buy(index, 'put');
                    },
                    child: const Text('Down'))),
          ]);

  Widget _getRefresh(TradeServiceNotifier positionNotifier, NiftyQuote data) =>
      Row(mainAxisAlignment: MainAxisAlignment.end, children: [
        Padding(
          padding: EdgeInsets.only(right: 144.0),
          child: Text(
            data.token == '26000' ? 'NIFTY' : data.token == '26009' ? 'BANKNIFTY' : "FINNIFTY"
          ),
        ),

        Padding(
          padding: EdgeInsets.only(left: 8.0),
          child: Text(
            data.ltt,
          ),
        ),
      ]);

  Widget _getIndexName(
          TradeServiceNotifier positionNotifier, NiftyQuote data) =>
      Row(mainAxisAlignment: MainAxisAlignment.end, children: [
        Padding(
          padding: EdgeInsets.only(left: 8.0),
          child: Text(
            data.ltt,
          ),
        ),
      ]);

  Widget _getNiftyVariables(NiftyQuote data) {
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
            variable: 'Change From High',
            value: data.highVariation,
          ))
        ],
      ),
      Row(
        children: [
          Expanded(
              child: VariableCard(
            variable: 'Opened With Difference',
            value: data.openVariation,
          )),
          Flexible(
              child: VariableCard(
            variable: 'Change From Open',
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
    final TextStyle variableStyle = Theme.of(context).textTheme.bodyLarge!;
    final TextStyle valueStyle = Theme.of(context).textTheme.labelLarge!;
    final TextStyle greenStyle = Theme.of(context)
        .textTheme
        .labelLarge!
        .apply(color: Colors.green, fontSizeFactor: 1.2);
    final TextStyle redStyle = Theme.of(context)
        .textTheme
        .labelLarge!
        .apply(color: Colors.red, fontSizeFactor: 1.2);
    return Card(
        child: Center(
      child: Column(children: <Widget>[
        Text(variable, style: variableStyle),
        SizedBox(height: 10),
        Text(value, style: int.parse(value) > 0 ? greenStyle : redStyle),
      ]),
    ));
  }
}
