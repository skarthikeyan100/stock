import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:cbse/provider/state/nifty_state.dart';

import '../model/nifty_quote.dart';
import 'nifty_stream_provider.dart';

final niftyProvider = Provider<NiftyState>((ref) {
  AsyncValue<dynamic> stream = ref.watch(niftyStreamProvider);
  NiftyState data = stream.when(data: (data) {
    return NiftyState(NiftyQuote.fromJson(json.decode(data)));
  }, error: (error, stackTrace) {
    print('server not available');
    print('Error: $error');
    print('stackTrace: $stackTrace');
    Future.microtask(() => ref.invalidate(niftyStreamProvider));
    return ErrorNiftyState(); 
  }, loading: () {
    return LoadingNiftyState();
  });

  return data;
});
