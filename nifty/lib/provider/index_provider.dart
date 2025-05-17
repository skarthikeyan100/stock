import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../model/nifty_quote.dart';
import '../service/service.dart';
import 'nifty_stream_provider.dart';

const niftyToken = '26000';
const finNiftyToken = '26037';
const bankNiftyToken = '26009';

class IndexState {
  NiftyQuote niftyQuote;
  NiftyQuote finNiftyQuote;
  NiftyQuote bankNiftyQuote;

  IndexState.empty()
      : niftyQuote = NiftyQuote.empty(),
        finNiftyQuote = NiftyQuote.empty(),
        bankNiftyQuote = NiftyQuote.empty();
  IndexState(this.niftyQuote, this.finNiftyQuote, this.bankNiftyQuote);

  static IndexState fromJson(Map<String, dynamic> json) {
    IndexState state = IndexState.empty();
    return state;
  }

  IndexState copy() {
    IndexState newState = IndexState(
        niftyQuote.copy(), finNiftyQuote.copy(), bankNiftyQuote.copy());
    return newState;
  }
}

class LoadingIndexState extends IndexState {
  LoadingIndexState() : super.empty();
}

class ErrorIndexState extends IndexState {
  ErrorIndexState() : super.empty();
}

class IndexStateNotifier extends StateNotifier<IndexState> {
  IndexStateNotifier() : super(IndexState.empty());

  Future<void> _updateQuotes() async {
    print('Update quotes now 123');
    //TODO fails as not logged in
    // dynamic data = await Service().getQuotes();
    // print('Got quotes: ${data['nifty']}');
    IndexState newState = state.copy();

    newState.niftyQuote = NiftyQuote.empty();
    newState.bankNiftyQuote = NiftyQuote.empty();
    newState.finNiftyQuote = NiftyQuote.empty();

    // print('newState is $newState');
    state = newState;
  }

  void update(AsyncValue<dynamic> stream) async {
    stream.when(data: (data) {
      IndexState newState = state.copy();
      Map<String, dynamic> response = json.decode(data);

      newState.niftyQuote = NiftyQuote.fromJson(response['nifty']);
      // newState.bankNiftyQuote = NiftyQuote.fromJson(response['bankNifty']);
      // newState.finNiftyQuote = NiftyQuote.fromJson(response['finNifty']);
      state = newState;
    }, error: (error, stackTrace) {
      print('server not available');
      print('Error: $error');
      print('stackTrace: $stackTrace');
      state = ErrorIndexState();
    }, loading: () async {
      print('Loading now');
      await _updateQuotes();
      print('Loading Done');
    });
  }
}

final indexProvider =
    StateNotifierProvider<IndexStateNotifier, IndexState>((ref) {
  AsyncValue<dynamic> stream = ref.watch(niftyStreamProvider);
  IndexStateNotifier notifier = IndexStateNotifier();
  notifier.update(stream);
  return notifier;
});
