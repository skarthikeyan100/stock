import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import 'package:cbse/provider/position_provider.dart';


class OptionStreamData {
  final num ltp;
  final String time;
  final String token;

  OptionStreamData(this.ltp, this.time, this.token);

  static OptionStreamData fromJson(Map<String, dynamic> json) {
    num ltp = _asnum(json['ltp']);
    String time = formatDate(json['ltt']);
    String token = json['token'];
    return OptionStreamData(ltp, time, token);
  }

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

  static String formatDate(dynamic str) {
    String time = 'NA';
    if (str.runtimeType.toString() == 'int') {
      DateTime date = DateTime.fromMillisecondsSinceEpoch(str).toLocal();
      var dateValue = DateFormat("yyyy-MM-ddTHH:mm:ss").format(date);
      String formattedDate = DateFormat("dd MMM yyyy hh:mm").format(date);
      return '${date.hour}:${date.minute}';
    } else if (str.runtimeType.toString() == 'String') {
      // print(' Date is string type');
    } else {
      // print('why here ?? ${str.runtimeType}');
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
        DateTime date =
            DateTime.fromMillisecondsSinceEpoch(num.parse(str).toInt());
        return '${date.hour}:${date.minute}';
      }
    }
    return time;
  }

  @override
  String toString() {
    return 'token: $token, ltp: $ltp';
  }
}
