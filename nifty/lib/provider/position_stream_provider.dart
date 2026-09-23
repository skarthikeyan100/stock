import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:cbse/provider/settings_provider.dart';
import 'package:cbse/provider/state/nifty_state.dart';
import '../model/nifty_quote.dart';
import '../util/sse_client.dart';




   final positionStreamProvider = StreamProvider<dynamic>((ref) {
     return Stream.periodic(const Duration(minutes: 1), (count) {

        const price = 10;
        const ltp = 5;
              final trade = <String, dynamic>{
              'tsym': 'tsym',
              'token': 'token',
              'strikePrice': 'strikePrice',
              'right': 'right',
              'action': 'action',
              'quantity': 'quantity',
              'price': price,
              'ltp': ltp,
              'option3Correctness': false,
              'questionNumber': 1
            };
            var r = [ trade ];

            var controller = StreamController<dynamic>();
            controller.add(r);
          return controller.stream;
      
     }); // Example: Emits an integer every second
   });

// final positionStreamProvider = StreamProvider<dynamic>((ref) {
//   String host = ref.watch(settingsProvider.select((value) => value.host));
//   return SSEClient.subscribeToSSE(
//       url: 'http://$host:3000/positionstream',
//       header: {
//         "Accept": "text/event-stream",
//         "Cache-Control": "no-cache",
//         "Connection": "Keep-Alive",
//       },
//       );
// });
