import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:cbse/provider/state/nifty_state.dart';

import '../model/nifty_quote.dart';
import '../service/service.dart';
import 'nifty_stream_provider.dart';


class NiftyStateNotifier extends StateNotifier<AsyncValue<NiftyState>> {
  dynamic ref;

  NiftyStateNotifier(this.ref) : super(const AsyncValue.loading()) {
    monitor();
    _fetch();
  }

  Future<void> _fetch() async {
    state = const AsyncValue.loading();
    state = await AsyncValue.guard(() => _fetchNiftyQuote());
  }

  Future<void> refresh() async {
    _fetch();
  }

  void monitor() {
    // print('Subscribe to SSE');
    AsyncValue stream = ref.watch(niftyStreamProvider);
    dynamic data = stream.when(data: (data) {
      return "data";
    }, error: (error, stackTrace) {
      print("error in Monitor: $error");
      return "error";
    }, loading: () {
      return "loading";
    });
    print("Data returened from stream.when is $data");

    // final AsyncValue stream = ref.watch(niftyStreamProvider);
    // stream.when(
    //     data: (data) => print(' Data is $data'),
    //     loading: () => print('Loading'),
    //     error: (e, st) => print('Error: $e'));
    print('Subscribed to SSE');
  }

Future<NiftyState> _fetchNiftyQuote() async {
  print('Fetching NiftyQuote');
  NiftyQuote niftyQuote = await Service().getNiftyQuote();
  print('Received from service $niftyQuote');
  NiftyState state = NiftyState(niftyQuote);
  print('NiftyState is ${state.niftyQuote}');
  return state;
}

}


final niftyProvider =
    StateNotifierProvider<NiftyStateNotifier, AsyncValue<NiftyState>>((ref) {
      print('Constructed niftyProvider ');
  NiftyStateNotifier notifier = NiftyStateNotifier(ref);
  return notifier;
});
