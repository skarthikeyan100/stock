import '../util/util.dart';

class OptionQuote {
  final num ltp;
  final String ltt;
  final num open;
  final num high;
  final num low;
  final num prevClose;

  OptionQuote(
      this.ltp, this.ltt, this.open, this.high, this.low, this.prevClose);

  static OptionQuote fromJson(Map<String, dynamic> json) {
    num ltp = Util.asnum(json['ltp']);
    String ltt = json['ltt'];
    num open = Util.asnum(json['open']);
    num high = Util.asnum(json['high']);
    num low = Util.asnum(json['low']);
    num prevClose = Util.asnum(json['prevClose']);
    return OptionQuote(ltp, ltt, open, high, low, prevClose);
  }
}
