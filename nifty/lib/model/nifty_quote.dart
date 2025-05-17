import 'package:intl/intl.dart';

import '../util/util.dart';

class NiftyQuote {
  final String token;
  final num ltp;
  final String ltt;
  final num open;
  final num high;
  final num low;
  final num close;
  final num prevClose;

  NiftyQuote.empty()
      : token = '',
        ltp = 0,
        ltt = '',
        open = 0,
        high = 0,
        low = 0,
        close = 0,
        prevClose = 0;

  NiftyQuote(this.token, this.ltp, this.ltt, this.open, this.high, this.low, this.close,
      this.prevClose);

  static NiftyQuote fromJson(Map<String, dynamic> json) {
    num ltp = _asnum(json['ltp']);
    String ltt = formatNiftyDate(json['ltt']);
    String token = json['token'];
    num open = _asnum(json['open']);
    num high = _asnum(json['high']);
    num low = _asnum(json['low']);
    num close = _asnum(json['close']);
    num prevClose = _asnum(json['prevClose']);

    return NiftyQuote(token, ltp, ltt, open, high, low, close, prevClose);
   
  }

  NiftyQuote copy() {
    return NiftyQuote(token, ltp, ltt, open, high, low, close, prevClose);
  }

  String get change => _getChange(ltp, prevClose);

  String get highVariation => _getChange(ltp, high);

  String get lowVariation => _getChange(ltp, low);

  String get openVariation => _getChange(open, prevClose);

  String get changeVariation => _getChange(ltp, open);

  String _getChange(num from, num to) {
    num n = from - to;
    return n.toStringAsFixed(0);
  }


  // static NiftyQuote fromPrism(Map<String, dynamic> json) {
  //     num ltp = _asnum(json['lp']);
  //     String ltt = formatNiftyDate(json['lut']);
  //     num open = _asnum(json['o']);
  //     num high = _asnum(json['h']);
  //     num low = _asnum(json['l']);
  //     num close = _asnum(json['c']);
  //     return NiftyQuote(ltp, ltt, open, high, low, close, prevClose);
  // }

  static num _asnum(dynamic number) {
    num result = 0;

    if (number != null) {
      if (number.runtimeType == String) {
        return num.parse(number as String);
      }
      result = number as num;
    }
    return result;
  }

  static String formatDate(String str) {
    String time = 'NA';
    if (str != null) {
      List<String> times = str.split(' ');
      if (times.length > 1) {
        time = times[1];
        times = time.split(':');
        if (times.length > 2) {
          time = '${times[0]}:${times[1]}';
        }
      }
    }
    return time;
  }

  static String formatNiftyDate(dynamic str) {
    String time = 'NA';
    if (str.runtimeType.toString() == 'int') {
      DateTime date = DateTime.fromMillisecondsSinceEpoch(str).toLocal();
      var dateValue = DateFormat("yyyy-MM-ddTHH:mm:ss").format(date);
      String formattedDate = DateFormat("dd MMM yyyy hh:mm").format(date);
      return '${date.hour}:${date.minute}';
    }

    if (str != null) {
      List<String> times = str.split(' ');
      if (times.length > 1) {
        time = times[3];
        times = time.split(':');
        if (times.length > 2) {
          time = '${times[0]}:${times[1]}';
        }
      } else {
        //It is a timestamp
        DateTime date = DateTime.fromMillisecondsSinceEpoch(
            num.parse(str).toInt() * 1000,
            isUtc: false);
        return '${date.hour}:${date.minute}';
      }
    }
    return time;
  }

  @override
  String toString() {
    return 'NiftyQuote: { $ltp}';
  }
}
