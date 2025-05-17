import '../../model/nifty_quote.dart';

class NiftyState {
  final NiftyQuote niftyQuote;

  NiftyState.empty(): niftyQuote = NiftyQuote.empty();
  NiftyState(this.niftyQuote);

  String get change => _getChange(niftyQuote.ltp, niftyQuote.prevClose);

  String get highVariation => _getChange(niftyQuote.ltp, niftyQuote.high);

  String get lowVariation => _getChange(niftyQuote.ltp, niftyQuote.low);

  String get openVariation => _getChange(niftyQuote.open, niftyQuote.prevClose);

  String get changeVariation => _getChange(niftyQuote.ltp, niftyQuote.open);

  String _getChange(num from, num to) {
    num n = from - to;
    return n.toStringAsFixed(0);
  }

  static NiftyState copy(NiftyState old) {
    return old;
  }
}

class LoadingNiftyState extends NiftyState {
  LoadingNiftyState() : super.empty();
}

class ErrorNiftyState extends NiftyState {
  ErrorNiftyState() : super.empty();
}