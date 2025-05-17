import 'package:cbse/component/contract_card.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../component/nifty_card.dart';
import '../component/position_card.dart';
import '../model/position.dart';
import 'home_page.dart';

class MonitorScreen extends ConsumerWidget {
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return _getScreenWidget(context);
  }

  Widget _getScreenWidget(BuildContext context) {

return GestureDetector(
        onTap: () => FocusManager.instance.primaryFocus?.unfocus(),
        child: Scaffold(
          appBar: AppBar(
            title: Text('Application Settings'),
            actions: [
              IconButton(
                  onPressed: () {
                    Navigator.pushReplacement(
                        context,
                        MaterialPageRoute(
                            builder: (BuildContext context) => HomePage()));
                  },
                  icon: Icon(Icons.home))
            ],
          ),
          body: 

   Container(
      color: Color(0xFFe8f4f7),
      child:ListView(

      children: [ ContractCard(), NiftyCard(), Expanded(child:PositionCard(Position()))],
    ))));
  }

}
