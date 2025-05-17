import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:cbse/provider/trade_service_provider.dart';
import 'package:cbse/screen/prism_screen.dart';
import 'package:cbse/service/service.dart';

import '../provider/nifty_provider.dart';
import '../provider/nifty_stream_provider.dart';
import '../provider/option_stream_provider.dart';
import '../provider/position_provider.dart';
import '../provider/position_stream_provider.dart';
import 'monitor_screen.dart';
import 'settings.dart';

class HomePage extends ConsumerWidget {
  bool connected;
  HomePage({this.connected=false, Key? key}) : super(key: key);

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    debugPrint('In Build Home Page');
    if(connected == true) {
        ref.refresh(positionStreamProvider);
        ref.refresh(niftyStreamProvider);
        ref.refresh(optionStreamProvider);
    }

    return Scaffold(
      appBar: AppBar(
        title: Center(child: Text('Trade Nifty Option')),
        actions: [
          IconButton(
              onPressed: () async {
                ref.refresh(positionStreamProvider);
                ref.refresh(niftyStreamProvider);
              },
              icon: Icon(Icons.refresh)),

          IconButton(
              onPressed: () {
                Navigator.pushReplacement(
                    context,
                    MaterialPageRoute(
                        builder: (BuildContext context) => MonitorScreen()));
              },
              icon: Icon(Icons.graphic_eq)),

          IconButton(
              onPressed: () {
                Navigator.pushReplacement(
                    context,
                    MaterialPageRoute(
                        builder: (BuildContext context) => Settings()));
              },
              icon: Icon(Icons.settings))
        ],
      ),
      body: PrismScreen(),
    );
  }
}
