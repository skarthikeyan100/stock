import 'package:flutter/material.dart';

import '../component/nifty_card.dart';

class OrderScreen extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return _getContainer();
  }

  Widget _getContainer() {
    debugPrint('In Here');
    return Container(
        color: Colors.green.shade100,
        height: 200,
        child: Column(children: [
          NiftyCard(),
        ]));
  }
}
