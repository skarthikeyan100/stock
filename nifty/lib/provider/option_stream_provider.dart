import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:cbse/provider/settings_provider.dart';
import 'package:cbse/provider/state/nifty_state.dart';
import '../model/nifty_quote.dart';
import '../util/sse_client.dart';




final optionStreamProvider = StreamProvider<dynamic>((ref) {
  String host = ref.watch(settingsProvider.select((value) => value.host));

  print('*******  Constructed optionStreamProvider host: $host');
  return SSEClient.subscribeToSSE(
      url: 'http://$host:3000/optionstream',
      header: {
        "Accept": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "Keep-Alive",
      },
      );
});
