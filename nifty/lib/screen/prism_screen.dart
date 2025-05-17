import 'package:cbse/component/contract_card.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../component/index_card.dart';
import '../component/position_card.dart';
import '../component/target_price_card.dart';
import '../model/position.dart';
import '../provider/index_provider.dart';
import '../provider/position_provider.dart';

class PrismScreen extends ConsumerWidget {
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    IndexState indexState = ref.watch(indexProvider);
    PositionState positionState = ref.watch(positionProvider);
    return _getScreenWidget(indexState, positionState);
  }

  Widget _getScreenWidget(IndexState indexState, PositionState positionState) {

    // return SingleChildScrollView(
    //   scrollDirection: Axis.vertical,
    //   child: Column(children: [
    //     IndexCard(), Expanded(child:PositionCard())
    //   ],)
    // );
    List<Widget> cards = [];
    cards.add(TargetPriceCard());
    cards.add(ContractCard());
    cards.add(IndexCard(indexState, indexState.niftyQuote));
    
    for (Position position in positionState.positions) {
      cards.add(PositionCard(position));
    }

    return Container(
      color: Color(0xFFe8f4f7),
      child:ListView(

      children: cards,
    ));
  }

}
